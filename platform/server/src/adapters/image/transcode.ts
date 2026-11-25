import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import decodePng, { init as initPng } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";
import { tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import {
    AVATAR_MAX_BYTES,
    AVATAR_MAX_SIDE,
    AVATAR_SIDES,
    type ChildAnswer,
    toChildFrame,
} from "./frame.ts";
import { firstWebpFrame, readDimensions } from "./header.ts";
import { type ImageFormat, sniffImage } from "./sniff.ts";
import { type Rgba, toSquare } from "./square.ts";
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

async function cappedModule(file: string): Promise<WebAssembly.Module> {
    const bytes = await Bun.file(Bun.fileURLToPath(import.meta.resolve(file))).bytes();
    const capped = capWasmMemory(bytes, WASM_MEMORY_MAX_BYTES);
    if (!capped.ok) return Promise.reject(new Error(`${file}: ${capped.error.detail}`));
    return new WebAssembly.Module(capped.value);
}

type WasmImports = ConstructorParameters<typeof WebAssembly.Instance>[1];

// Emscripten's hook for bringing your own instance: ours is built from the capped module.
export function instantiateFrom(module: WebAssembly.Module) {
    return {
        instantiateWasm: (imports: WasmImports, done: (instance: WebAssembly.Instance) => void) => {
            const instance = new WebAssembly.Instance(module, imports);
            done(instance);
            return instance.exports;
        },
    };
}

async function decoderFor(format: ImageFormat): Promise<(bytes: Uint8Array) => Promise<unknown>> {
    const module = await cappedModule(WASM_FILES[format]);
    if (format === "png") {
        await initPng(module);
        return (bytes) => decodePng(bytes.slice().buffer);
    }
    if (format === "jpeg") {
        await initJpeg(instantiateFrom(module));
        return (bytes) => decodeJpeg(bytes.slice().buffer);
    }
    await initWebpDecode(instantiateFrom(module));
    return (bytes) => decodeWebp(bytes.slice().buffer);
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

async function encode(image: Rgba): Promise<Result<Uint8Array, "UNDECODABLE">> {
    const encoded = await tryAsync(
        () => encodeWebp(image, { quality: WEBP_QUALITY }),
        () => null,
    );
    if (!encoded.ok) return err("UNDECODABLE");
    return ok(new Uint8Array(encoded.value));
}

export async function transcodeUpload(bytes: Uint8Array): Promise<ChildAnswer> {
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

    const decoded = await tryAsync(
        async () => (await decoderFor(format))(still.value),
        () => null,
    );
    const image = decoded.ok ? asRgba(decoded.value, declared.value) : null;
    if (image === null) return { ok: false, refusal: "UNDECODABLE" };

    const encoder = await tryAsync(
        async () => initWebpEncode(instantiateFrom(await cappedModule(WASM_FILES.encoder))),
        () => null,
    );
    if (!encoder.ok) return { ok: false, refusal: "UNDECODABLE" };
    const [largeSide, smallSide] = AVATAR_SIDES;
    const largeSquare = toSquare(image, largeSide);
    const large = await encode(largeSquare);
    const small = await encode(toSquare(largeSquare, smallSide));
    if (!large.ok || !small.ok) return { ok: false, refusal: "UNDECODABLE" };
    return { ok: true, large: large.value, small: small.value };
}

export async function runAvatarChild(): Promise<void> {
    const input = await Bun.stdin.bytes();
    const answer = await transcodeUpload(input);
    await Bun.write(Bun.stdout, toChildFrame(answer));
}
