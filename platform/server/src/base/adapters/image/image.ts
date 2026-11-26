import { describeUnknownError, tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { AVATAR_MAX_BYTES, parseChildFrame } from "./frame.ts";
import { sniffImage } from "./sniff.ts";

// Avatars from untrusted uploads. The bytes are decoded only in a child process (image-child.ts)
// started with an empty environment, the upload on stdin and the answer on stdout, and killed at
// its deadline; this side reads nothing of the image but its magic bytes and the frame the child
// answers. What comes back is two WebPs re-encoded from pixels alone, so nothing the upload
// carried besides its picture (EXIF, ICC, text, later frames) survives.

export type AvatarImages = { readonly large: Uint8Array; readonly small: Uint8Array };

export type ImageRefusal =
    | { readonly code: "IMAGE_TOO_LARGE" }
    | { readonly code: "NOT_AN_IMAGE" }
    | { readonly code: "IMAGE_UNDECODABLE" }
    | { readonly code: "IMAGE_TIMED_OUT" };

// Not the upload's fault: every decoder slot stayed taken past the wait (IMAGE_BUSY), the child
// could not be started (IMAGE_CHILD_FAILED), or its codec would not load or run
// (IMAGE_CODEC_FAILED, with what the child said on stderr).
export type ImageFailure =
    | { readonly code: "IMAGE_BUSY" }
    | { readonly code: "IMAGE_CHILD_FAILED"; readonly detail: string }
    | { readonly code: "IMAGE_CODEC_FAILED"; readonly detail: string };

export { AVATAR_MAX_BYTES };

export const IMAGE_CHILD_DEADLINE_MS = 5_000;
// Two WebPs of at most 256 px a side come to far less; a child writing more is broken.
const FRAME_MAX_BYTES = 2 * 1024 * 1024;
// What of the child's stderr reaches the log line.
const STDERR_MAX_BYTES = 2 * 1024;

const CHILD_ENTRY = Bun.fileURLToPath(new URL("./image-child.ts", import.meta.url));

export type DecoderSlots = {
    // True once a slot is held, false when none came free within the wait.
    readonly acquire: () => Promise<boolean>;
    readonly release: () => void;
};

// At most `limit` decoder children at once; a caller waits up to `waitMs` for one to finish. A
// released slot passes straight to the longest waiter, so the count never goes over.
export function createDecoderSlots(params: {
    readonly limit: number;
    readonly waitMs: number;
}): DecoderSlots {
    let held = 0;
    const waiting: (() => void)[] = [];
    return {
        acquire: () =>
            new Promise<boolean>((resolve) => {
                if (held < params.limit) {
                    held += 1;
                    resolve(true);
                    return;
                }
                const grant = () => {
                    clearTimeout(timer);
                    resolve(true);
                };
                const timer = setTimeout(() => {
                    const at = waiting.indexOf(grant);
                    if (at >= 0) waiting.splice(at, 1);
                    resolve(false);
                }, params.waitMs);
                waiting.push(grant);
            }),
        release: () => {
            const next = waiting.shift();
            if (next === undefined) {
                held -= 1;
                return;
            }
            next();
        },
    };
}

// Process-wide: each child may hold up to two 640 MiB WebAssembly memories, so two at once is
// the most this server's container lets untrusted images take.
const DECODER_SLOTS = createDecoderSlots({ limit: 2, waitMs: 2_000 });

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

// stdout up to `limit` bytes, or null once it goes past.
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const part of stream) {
        total += part.length;
        if (total > limit) return null;
        parts.push(part);
    }
    return concat(parts, total);
}

// The first `limit` bytes of stderr as text; the rest is read and dropped, so a chatty child
// never blocks on a full pipe.
async function readHead(stream: ReadableStream<Uint8Array>, limit: number) {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const part of stream) {
        if (total >= limit) continue;
        const kept = part.subarray(0, limit - total);
        parts.push(kept);
        total += kept.length;
    }
    return new TextDecoder().decode(concat(parts, total)).trim();
}

async function runChild(
    bytes: Uint8Array,
    entry: string,
    deadlineMs: number,
    args: readonly string[] = [],
): Promise<Result<AvatarImages, ImageRefusal | ImageFailure>> {
    const deadline = AbortSignal.timeout(deadlineMs);
    const child = await tryAsync(
        async () =>
            Bun.spawn([process.execPath, entry, ...args], {
                env: {},
                stdin: bytes,
                stdout: "pipe",
                stderr: "pipe",
                signal: deadline,
                killSignal: "SIGKILL",
            }),
        (cause) => ({ code: "IMAGE_CHILD_FAILED" as const, detail: describeUnknownError(cause) }),
    );
    if (!child.ok) return child;
    const proc = child.value;
    // Read alongside stdout, so neither pipe fills while the other is waited on.
    const said = tryAsync(
        () => readHead(proc.stderr, STDERR_MAX_BYTES),
        () => "",
    );
    const frame = await tryAsync(
        () => readBounded(proc.stdout, FRAME_MAX_BYTES),
        () => null,
    );
    if (!frame.ok || frame.value === null) proc.kill("SIGKILL");
    const exitCode = await proc.exited;
    const stderr = await said;
    if (deadline.aborted) return err({ code: "IMAGE_TIMED_OUT" });
    if (exitCode !== 0 || !frame.ok || frame.value === null) {
        return err({ code: "IMAGE_UNDECODABLE" });
    }
    const answer = parseChildFrame(frame.value);
    if (answer === null) return err({ code: "IMAGE_UNDECODABLE" });
    if (!answer.ok) {
        if (answer.refusal === "TOO_LARGE") return err({ code: "IMAGE_TOO_LARGE" });
        if (answer.refusal === "NOT_AN_IMAGE") return err({ code: "NOT_AN_IMAGE" });
        if (answer.refusal === "CODEC_FAILED") {
            const detail = stderr.ok && stderr.value !== "" ? stderr.value : "no detail";
            return err({ code: "IMAGE_CODEC_FAILED", detail });
        }
        return err({ code: "IMAGE_UNDECODABLE" });
    }
    // Banner mode leaves the small slot empty by design; the banner check is the caller's.
    const smallOk = args.includes("banner") || sniffImage(answer.small) === "webp";
    if (sniffImage(answer.large) !== "webp" || !smallOk) {
        return err({ code: "IMAGE_UNDECODABLE" });
    }
    return ok({ large: answer.large, small: answer.small });
}

export type TranscodeOptions = {
    readonly deadlineMs?: number;
    // Tests stand other children in for the real one (one that never answers, one whose
    // codec is broken) and give the slots a limit of their own.
    readonly entry?: string;
    readonly slots?: DecoderSlots;
};

async function transcode(
    bytes: Uint8Array,
    args: readonly string[],
    options?: TranscodeOptions,
): Promise<Result<AvatarImages, ImageRefusal | ImageFailure>> {
    if (bytes.length > AVATAR_MAX_BYTES) return err({ code: "IMAGE_TOO_LARGE" });
    if (sniffImage(bytes) === null) return err({ code: "NOT_AN_IMAGE" });
    const slots = options?.slots ?? DECODER_SLOTS;
    if (!(await slots.acquire())) return err({ code: "IMAGE_BUSY" });
    // runChild contains its own failures, so the slot is always given back.
    const result = await tryAsync(
        () =>
            runChild(
                bytes,
                options?.entry ?? CHILD_ENTRY,
                options?.deadlineMs ?? IMAGE_CHILD_DEADLINE_MS,
                args,
            ),
        (cause) => ({ code: "IMAGE_CHILD_FAILED" as const, detail: describeUnknownError(cause) }),
    );
    slots.release();
    if (!result.ok) return result;
    return result.value;
}

export async function transcodeAvatar(
    bytes: Uint8Array,
    options?: TranscodeOptions,
): Promise<Result<AvatarImages, ImageRefusal | ImageFailure>> {
    return await transcode(bytes, [], options);
}

// The same upload through the same child in its banner mode: one 1500x400 WebP in the frame's
// large slot. Everything else — limits, refusals, deadlines, slots — is the avatar's.
export async function transcodeBanner(
    bytes: Uint8Array,
    options?: TranscodeOptions,
): Promise<Result<Uint8Array, ImageRefusal | ImageFailure>> {
    const images = await transcode(bytes, ["banner"], options);
    if (!images.ok) return images;
    if (sniffImage(images.value.large) !== "webp") return err({ code: "IMAGE_UNDECODABLE" });
    return ok(images.value.large);
}
