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

// The child could not be started at all: the server's fault, not the upload's.
export type ImageFailure = { readonly code: "IMAGE_CHILD_FAILED"; readonly detail: string };

export { AVATAR_MAX_BYTES };

export const IMAGE_CHILD_DEADLINE_MS = 5_000;
// Two WebPs of at most 256 px a side come to far less; a child writing more is broken.
const FRAME_MAX_BYTES = 2 * 1024 * 1024;

const CHILD_ENTRY = Bun.fileURLToPath(new URL("./image-child.ts", import.meta.url));

// stdout up to `limit` bytes, or null once it goes past.
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number) {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const part of stream) {
        total += part.length;
        if (total > limit) return null;
        parts.push(part);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

export async function transcodeAvatar(
    bytes: Uint8Array,
    options?: {
        readonly deadlineMs?: number;
        // Tests stand a child that never answers in for the real one.
        readonly entry?: string;
    },
): Promise<Result<AvatarImages, ImageRefusal | ImageFailure>> {
    if (bytes.length > AVATAR_MAX_BYTES) return err({ code: "IMAGE_TOO_LARGE" });
    if (sniffImage(bytes) === null) return err({ code: "NOT_AN_IMAGE" });
    const deadline = AbortSignal.timeout(options?.deadlineMs ?? IMAGE_CHILD_DEADLINE_MS);
    const child = await tryAsync(
        async () =>
            Bun.spawn([process.execPath, options?.entry ?? CHILD_ENTRY], {
                env: {},
                stdin: bytes,
                stdout: "pipe",
                stderr: "ignore",
                signal: deadline,
                killSignal: "SIGKILL",
            }),
        (cause) => ({ code: "IMAGE_CHILD_FAILED" as const, detail: describeUnknownError(cause) }),
    );
    if (!child.ok) return child;
    const proc = child.value;
    const frame = await tryAsync(
        () => readBounded(proc.stdout, FRAME_MAX_BYTES),
        () => null,
    );
    if (!frame.ok || frame.value === null) proc.kill("SIGKILL");
    const exitCode = await proc.exited;
    if (deadline.aborted) return err({ code: "IMAGE_TIMED_OUT" });
    if (exitCode !== 0 || !frame.ok || frame.value === null) {
        return err({ code: "IMAGE_UNDECODABLE" });
    }
    const answer = parseChildFrame(frame.value);
    if (answer === null) return err({ code: "IMAGE_UNDECODABLE" });
    if (!answer.ok) {
        if (answer.refusal === "TOO_LARGE") return err({ code: "IMAGE_TOO_LARGE" });
        if (answer.refusal === "NOT_AN_IMAGE") return err({ code: "NOT_AN_IMAGE" });
        return err({ code: "IMAGE_UNDECODABLE" });
    }
    if (sniffImage(answer.large) !== "webp" || sniffImage(answer.small) !== "webp") {
        return err({ code: "IMAGE_UNDECODABLE" });
    }
    return ok({ large: answer.large, small: answer.small });
}
