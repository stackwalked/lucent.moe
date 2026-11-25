import { err, ok, type Result } from "@lucent/core/result";
import type { ImageFormat } from "./sniff.ts";

// Header reads that run in the decoder child before any codec sees the bytes: an image's declared
// size is refused before a decoder allocates for it, so a small file claiming a huge canvas
// costs nothing. Layouts: PNG IHDR (ISO/IEC 15948 5.3, 11.2.2), JPEG SOFn markers (ITU T.81
// B.2.2), WebP RIFF chunks VP8/VP8L/VP8X/ANMF (RFC 9649). Wrong reads refuse good images, never
// let a large one through: the codec decodes what the header promised or fails.

export type Dimensions = { readonly width: number; readonly height: number };
type HeaderFailure = "UNDECODABLE";

function u16be(b: Uint8Array, at: number): number {
    return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}

function u16le(b: Uint8Array, at: number): number {
    return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
}

function u24le(b: Uint8Array, at: number): number {
    return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
}

function u32be(b: Uint8Array, at: number): number {
    return u16be(b, at) * 0x10000 + u16be(b, at + 2);
}

function u32le(b: Uint8Array, at: number): number {
    return u16le(b, at) + u16le(b, at + 2) * 0x10000;
}

function fourcc(b: Uint8Array, at: number): string {
    return String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);
}

function sized(width: number, height: number): Result<Dimensions, HeaderFailure> {
    if (width <= 0 || height <= 0) return err("UNDECODABLE");
    return ok({ width, height });
}

function pngDimensions(b: Uint8Array): Result<Dimensions, HeaderFailure> {
    if (b.length < 24 || fourcc(b, 12) !== "IHDR") return err("UNDECODABLE");
    return sized(u32be(b, 16), u32be(b, 20));
}

// SOF0-3, 5-7, 9-11, 13-15; C4 (DHT), C8 (JPG) and CC (DAC) share the range but aren't frames.
function isStartOfFrame(marker: number): boolean {
    return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function jpegDimensions(b: Uint8Array): Result<Dimensions, HeaderFailure> {
    let at = 2;
    while (at + 4 <= b.length) {
        if (b[at] !== 0xff) return err("UNDECODABLE");
        const marker = b[at + 1] ?? 0;
        if (marker === 0xff) {
            at += 1;
            continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += 2;
            continue;
        }
        if (marker === 0xd9 || marker === 0xda) return err("UNDECODABLE");
        const length = u16be(b, at + 2);
        if (length < 2) return err("UNDECODABLE");
        if (isStartOfFrame(marker)) {
            if (at + 9 > b.length) return err("UNDECODABLE");
            return sized(u16be(b, at + 7), u16be(b, at + 5));
        }
        at += 2 + length;
    }
    return err("UNDECODABLE");
}

type Chunk = { readonly id: string; readonly start: number; readonly end: number };

// The chunks of a RIFF body between `from` and `to`, padded to even lengths.
function chunks(b: Uint8Array, from: number, to: number): Result<readonly Chunk[], HeaderFailure> {
    const out: Chunk[] = [];
    let at = from;
    while (at + 8 <= to) {
        const size = u32le(b, at + 4);
        const start = at + 8;
        const end = start + size;
        if (end > to) return err("UNDECODABLE");
        out.push({ id: fourcc(b, at), start, end });
        at = end + (size % 2);
    }
    return ok(out);
}

function riffChunks(b: Uint8Array): Result<readonly Chunk[], HeaderFailure> {
    if (b.length < 12) return err("UNDECODABLE");
    return chunks(b, 12, Math.min(b.length, 8 + u32le(b, 4)));
}

function bitstreamDimensions(b: Uint8Array, chunk: Chunk): Result<Dimensions, HeaderFailure> {
    if (chunk.id === "VP8 ") {
        const at = chunk.start;
        if (chunk.end - at < 10) return err("UNDECODABLE");
        if (b[at + 3] !== 0x9d || b[at + 4] !== 0x01 || b[at + 5] !== 0x2a) {
            return err("UNDECODABLE");
        }
        return sized(u16le(b, at + 6) & 0x3fff, u16le(b, at + 8) & 0x3fff);
    }
    if (chunk.id === "VP8L") {
        const at = chunk.start;
        if (chunk.end - at < 5 || b[at] !== 0x2f) return err("UNDECODABLE");
        const bits = u32le(b, at + 1);
        return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return err("UNDECODABLE");
}

function webpDimensions(b: Uint8Array): Result<Dimensions, HeaderFailure> {
    const found = riffChunks(b);
    if (!found.ok) return found;
    const first = found.value[0];
    if (first === undefined) return err("UNDECODABLE");
    if (first.id !== "VP8X") return bitstreamDimensions(b, first);
    if (first.end - first.start < 10) return err("UNDECODABLE");
    return sized(u24le(b, first.start + 4) + 1, u24le(b, first.start + 7) + 1);
}

// The size the bitstream itself declares in a still WebP (what firstWebpFrame makes, or an upload
// that was never animated): its top-level VP8 or VP8L chunk, whatever a VP8X before it claims.
// libwebp decodes to this size, so it is the one bounded before decoding.
export function webpBitstreamDimensions(b: Uint8Array): Result<Dimensions, HeaderFailure> {
    const found = riffChunks(b);
    if (!found.ok) return found;
    const bitstream = found.value.find((chunk) => chunk.id === "VP8 " || chunk.id === "VP8L");
    if (bitstream === undefined) return err("UNDECODABLE");
    return bitstreamDimensions(b, bitstream);
}

const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

// Searched at most this far: an Exif APP1 sits right after SOI in every camera's file.
const ORIENTATION_MAX_SEGMENTS = 32;
const ORIENTATION_MAX_ENTRIES = 256;
const ORIENTATION_TAG = 0x0112;
const TIFF_SHORT = 3;

// IFD0's Orientation in a TIFF header (TIFF 6.0 section 2, Exif 2.32 4.6.4 A): 1 to 8, else 1.
function tiffOrientation(t: Uint8Array): Orientation {
    if (t.length < 8) return 1;
    const little = t[0] === 0x49 && t[1] === 0x49;
    const big = t[0] === 0x4d && t[1] === 0x4d;
    if (!little && !big) return 1;
    const u16 = (at: number) => (little ? u16le(t, at) : u16be(t, at));
    const u32 = (at: number) => (little ? u32le(t, at) : u32be(t, at));
    if (u16(2) !== 42) return 1;
    const ifd = u32(4);
    if (ifd + 2 > t.length) return 1;
    const count = Math.min(u16(ifd), ORIENTATION_MAX_ENTRIES);
    for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > t.length) return 1;
        if (u16(entry) !== ORIENTATION_TAG) continue;
        if (u16(entry + 2) !== TIFF_SHORT || u32(entry + 4) !== 1) return 1;
        const value = u16(entry + 8);
        return ORIENTATIONS.find((o) => o === value) ?? 1;
    }
    return 1;
}

// How a JPEG asks to be turned for display, from the Orientation tag of its Exif APP1 segment.
// Only ever turns the picture: missing, malformed or out-of-range Exif is 1 (as stored), never a
// refusal. The tag is read here and applied to the pixels; the Exif itself is never kept.
export function readJpegOrientation(b: Uint8Array): Orientation {
    let at = 2;
    for (let seen = 0; seen < ORIENTATION_MAX_SEGMENTS && at + 4 <= b.length; seen++) {
        if (b[at] !== 0xff) return 1;
        const marker = b[at + 1] ?? 0;
        if (marker === 0xd9 || marker === 0xda || isStartOfFrame(marker)) return 1;
        const length = u16be(b, at + 2);
        if (length < 2) return 1;
        const start = at + 4;
        const end = Math.min(at + 2 + length, b.length);
        if (
            marker === 0xe1 &&
            fourcc(b, start) === "Exif" &&
            b[start + 4] === 0 &&
            b[start + 5] === 0
        ) {
            return tiffOrientation(b.subarray(start + 6, end));
        }
        at += 2 + length;
    }
    return 1;
}

export function readDimensions(
    format: ImageFormat,
    bytes: Uint8Array,
): Result<Dimensions, HeaderFailure> {
    if (format === "png") return pngDimensions(bytes);
    if (format === "jpeg") return jpegDimensions(bytes);
    return webpDimensions(bytes);
}

const VP8X_ANIMATION = 0x02;
const VP8X_ALPHA = 0x10;

function littleEndian(value: number, bytes: number): number[] {
    return Array.from({ length: bytes }, (_, i) => Math.floor(value / 256 ** i) & 0xff);
}

function riff(body: readonly Uint8Array[]): Uint8Array {
    const length = 4 + body.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(8 + length);
    out.set([...ascii("RIFF"), ...littleEndian(length, 4), ...ascii("WEBP")], 0);
    let at = 12;
    for (const part of body) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

function ascii(text: string): number[] {
    return Array.from(text, (ch) => ch.charCodeAt(0));
}

function chunkBytes(b: Uint8Array, chunk: Chunk): Uint8Array {
    const size = chunk.end - chunk.start;
    return b.subarray(chunk.start - 8, chunk.end + (size % 2));
}

// The libwebp decoder the codec wraps (WebPDecode) refuses animations, so an animated WebP is
// cut down to its first frame here: that frame's bitstream (and alpha) as a still WebP of the
// frame's own size. Its offset on the canvas is dropped; the canvas was already bounded.
export function firstWebpFrame(b: Uint8Array): Result<Uint8Array, HeaderFailure> {
    const found = riffChunks(b);
    if (!found.ok) return found;
    const head = found.value[0];
    if (head?.id !== "VP8X" || ((b[head.start] ?? 0) & VP8X_ANIMATION) === 0) return ok(b);
    const frame = found.value.find((chunk) => chunk.id === "ANMF");
    if (frame === undefined || frame.end - frame.start < 16) return err("UNDECODABLE");
    const inner = chunks(b, frame.start + 16, frame.end);
    if (!inner.ok) return inner;
    const bitstream = inner.value.find((chunk) => chunk.id === "VP8 " || chunk.id === "VP8L");
    if (bitstream === undefined) return err("UNDECODABLE");
    const alpha = inner.value.find((chunk) => chunk.id === "ALPH");
    if (alpha === undefined || bitstream.id === "VP8L") return ok(riff([chunkBytes(b, bitstream)]));
    // ANMF and VP8X both store width - 1 and height - 1 as 24-bit fields.
    const vp8x = Uint8Array.from([
        ...ascii("VP8X"),
        ...littleEndian(10, 4),
        ...littleEndian(VP8X_ALPHA, 4),
        ...littleEndian(u24le(b, frame.start + 6), 3),
        ...littleEndian(u24le(b, frame.start + 9), 3),
    ]);
    return ok(riff([vp8x, chunkBytes(b, alpha), chunkBytes(b, bitstream)]));
}
