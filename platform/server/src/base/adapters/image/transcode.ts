import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import decodePng, { init as initPng } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";
import { describeUnknownError, tryAsync, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import {
    AVATAR_MAX_BYTES,
    AVATAR_MAX_SIDE,
    AVATAR_SIDES,
    BANNER_HEIGHT,
    BANNER_WIDTH,
    type ChildAnswer,
    toChildFrame,
} from "./frame.ts";
import {
    firstWebpFrame,
    type Orientation,
    readDimensions,
    readJpegOrientation,
    webpBitstreamDimensions,
} from "./header.ts";
import { type ImageFormat, sniffImage } from "./sniff.ts";
import { orient, type Rgba, toCover, toSquare } from "./square.ts";
import { capWasmMemory } from "./wasm-memory.ts";

// The decoder child's work, from the upload's bytes to its answer frame. Runs only in the child
// (image-child.ts): the codecs are C and Rust compiled to WebAssembly, fed bytes from anyone.

// Per WebAssembly instance; the child holds at most one decoder and the encoder.
export const WASM_MEMORY_MAX_BYTES = 640 * 1024 * 1024;
const WEBP_QUALITY = 82;

// The codec builds this pins, read from the packages' own files (no exports map, so the paths
// are stable within a version). The WebP encoder's init picks its SIMD build wherever the
// runtime has SIMD, which Bun's JavaScriptCore does, so that is the binary it is given.
export const WASM_FILES = {
    jpeg: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
    png: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
    webp: "@jsquash/webp/codec/dec/webp_dec.wasm",
    encoder: "@jsquash/webp/codec/enc/webp_enc_simd.wasm",
} as const;

export type WasmFiles = { readonly [K in keyof typeof WASM_FILES]: string };

// A codec that would not load: the server's fault, said on stderr, never the member's.
type CodecFailure = string;

async function cappedModule(file: string): Promise<Result<WebAssembly.Module, CodecFailure>> {
    const bytes = await tryAsync(
        () => Bun.file(Bun.fileURLToPath(import.meta.resolve(file))).bytes(),
        (cause) => `${file}: ${describeUnknownError(cause)}`,
    );
    if (!bytes.ok) return bytes;
    const capped = capWasmMemory(bytes.value, WASM_MEMORY_MAX_BYTES);
    if (!capped.ok) return err(`${file}: ${capped.error.detail}`);
    return trySync(
        () => new WebAssembly.Module(capped.value),
        (cause) => `${file}: ${describeUnknownError(cause)}`,
    );
}

type WasmImports = ConstructorParameters<typeof WebAssembly.Instance>[1];

function memoryOf(exports: object): WebAssembly.Memory | null {
    return Object.values(exports).find((value) => value instanceof WebAssembly.Memory) ?? null;
}

// Emscripten's hook for bringing your own instance, built from the capped module. Emscripten
// instantiates on its own schedule and turns a failure into a rejected decode, so the hook also
// records whether an instance ever came to be (a decode that failed without one is the codec's
// fault, not the upload's) and which memory it runs on (what a test checks the cap against).
export function createInstantiation(module: WebAssembly.Module) {
    let memory: WebAssembly.Memory | null = null;
    let instantiated = false;
    return {
        options: {
            instantiateWasm: (
                imports: WasmImports,
                done: (instance: WebAssembly.Instance) => void,
            ) => {
                const instance = new WebAssembly.Instance(module, imports);
                instantiated = true;
                memory = memoryOf(instance.exports);
                done(instance);
                return instance.exports;
            },
        },
        memory: () => memory,
        instantiated: () => instantiated,
    };
}

export type OpenCodec<Run> = {
    readonly run: Run;
    readonly memory: () => WebAssembly.Memory | null;
    readonly instantiated: () => boolean;
};

// The decoder for one format, instantiated from its capped module.
export async function openDecoder(
    format: ImageFormat,
    files: WasmFiles = WASM_FILES,
): Promise<Result<OpenCodec<(bytes: Uint8Array) => Promise<unknown>>, CodecFailure>> {
    const module = await cappedModule(files[format]);
    if (!module.ok) return module;
    const failed = (cause: unknown) => `${files[format]}: ${describeUnknownError(cause)}`;
    if (format === "png") {
        // wasm-bindgen instantiates inside init, so a broken module fails here.
        const png = await tryAsync(() => initPng(module.value), failed);
        if (!png.ok) return png;
        const memory = png.value.memory;
        return ok({
            run: (bytes) => decodePng(bytes.slice().buffer),
            memory: () => memory,
            instantiated: () => true,
        });
    }
    const instantiation = createInstantiation(module.value);
    const opened = await tryAsync(async () => {
        if (format === "jpeg") {
            await initJpeg(instantiation.options);
            return (bytes: Uint8Array) => decodeJpeg(bytes.slice().buffer);
        }
        await initWebpDecode(instantiation.options);
        return (bytes: Uint8Array) => decodeWebp(bytes.slice().buffer);
    }, failed);
    if (!opened.ok) return opened;
    return ok({
        run: opened.value,
        memory: instantiation.memory,
        instantiated: instantiation.instantiated,
    });
}

// The WebP encoder, whose init waits for its instance, so a broken module fails here.
export async function openEncoder(
    files: WasmFiles = WASM_FILES,
): Promise<Result<OpenCodec<(image: Rgba) => Promise<ArrayBuffer>>, CodecFailure>> {
    const module = await cappedModule(files.encoder);
    if (!module.ok) return module;
    const instantiation = createInstantiation(module.value);
    const opened = await tryAsync(
        () => initWebpEncode(instantiation.options),
        (cause) => `${files.encoder}: ${describeUnknownError(cause)}`,
    );
    if (!opened.ok) return opened;
    return ok({
        run: (image: Rgba) => encodeWebp(image, { quality: WEBP_QUALITY }),
        memory: instantiation.memory,
        instantiated: instantiation.instantiated,
    });
}

// What came back from a codec, held to the size its header declared (or less, for the first
// frame of an animation) and to whole RGBA rows.
function asRgba(value: unknown, limit: { readonly width: number; readonly height: number }) {
    if (typeof value !== "object" || value === null) return null;
    if (!("width" in value && "height" in value && "data" in value)) return null;
    const { width, height, data } = value;
    if (typeof width !== "number" || typeof height !== "number") return null;
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return null;
    if (width < 1 || height < 1 || width > limit.width || height > limit.height) return null;
    if (data.length !== width * height * 4) return null;
    const image: Rgba = { width, height, data };
    return image;
}

function codecFailed(detail: string): ChildAnswer {
    return { ok: false, refusal: "CODEC_FAILED", detail };
}

export type TranscodeTarget = "avatar" | "banner";

export async function transcodeUpload(
    bytes: Uint8Array,
    files: WasmFiles = WASM_FILES,
    target: TranscodeTarget = "avatar",
): Promise<ChildAnswer> {
    if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, refusal: "TOO_LARGE" };
    const format = sniffImage(bytes);
    if (format === null) return { ok: false, refusal: "NOT_AN_IMAGE" };
    const declared = readDimensions(format, bytes);
    if (!declared.ok) return { ok: false, refusal: "UNDECODABLE" };
    const { width, height } = declared.value;
    if (width > AVATAR_MAX_SIDE || height > AVATAR_MAX_SIDE) {
        return { ok: false, refusal: "TOO_LARGE" };
    }
    const still = format === "webp" ? firstWebpFrame(bytes) : ok(bytes);
    if (!still.ok) return { ok: false, refusal: "UNDECODABLE" };
    // What the WebP decoder will actually allocate for: the bitstream's own size, which an
    // animation frame (or a lying VP8X) may set apart from the canvas checked above.
    if (format === "webp") {
        const frame = webpBitstreamDimensions(still.value);
        if (!frame.ok) return { ok: false, refusal: "UNDECODABLE" };
        if (frame.value.width > width || frame.value.height > height) {
            return { ok: false, refusal: "TOO_LARGE" };
        }
    }
    const orientation: Orientation = format === "jpeg" ? readJpegOrientation(bytes) : 1;

    const decoder = await openDecoder(format, files);
    if (!decoder.ok) return codecFailed(decoder.error);
    const decoded = await tryAsync(
        () => decoder.value.run(still.value),
        (cause) => describeUnknownError(cause),
    );
    if (!decoded.ok && !decoder.value.instantiated()) {
        return codecFailed(`${files[format]}: not instantiated: ${decoded.error}`);
    }
    const image = decoded.ok ? asRgba(decoded.value, declared.value) : null;
    if (image === null) return { ok: false, refusal: "UNDECODABLE" };

    const encoder = await openEncoder(files);
    if (!encoder.ok) return codecFailed(encoder.error);
    const upright = orient(image, orientation);
    const encode = (pixels: Rgba) =>
        tryAsync(
            async () => new Uint8Array(await encoder.value.run(pixels)),
            (cause) => `encoding: ${describeUnknownError(cause)}`,
        );
    if (target === "banner") {
        const banner = await encode(toCover(upright, BANNER_WIDTH, BANNER_HEIGHT));
        if (!banner.ok) return codecFailed(banner.error);
        // The frame keeps its two slots; the small one is empty in banner mode.
        return { ok: true, large: banner.value, small: new Uint8Array(0) };
    }
    const [largeSide, smallSide] = AVATAR_SIDES;
    const largeSquare = toSquare(upright, largeSide);
    const large = await encode(largeSquare);
    if (!large.ok) return codecFailed(large.error);
    const small = await encode(toSquare(largeSquare, smallSide));
    if (!small.ok) return codecFailed(small.error);
    return { ok: true, large: large.value, small: small.value };
}

export async function runAvatarChild(files: WasmFiles = WASM_FILES): Promise<void> {
    const input = await Bun.stdin.bytes();
    const target = process.argv[2] === "banner" ? "banner" : "avatar";
    const answer = await transcodeUpload(input, files, target);
    if (!answer.ok && answer.detail !== undefined) {
        await Bun.write(Bun.stderr, `${answer.detail}\n`);
    }
    await Bun.write(Bun.stdout, toChildFrame(answer));
}
