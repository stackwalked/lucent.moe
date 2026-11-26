// The formats an avatar may arrive in, told apart by their first bytes alone: what the client
// called the file or said its type was never counts. This is all of an upload the server process
// itself reads; everything past the magic bytes is the decoder child's.

export type ImageFormat = "jpeg" | "png" | "webp";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SOI = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
    if (bytes.length < at + prefix.length) return false;
    return prefix.every((byte, i) => bytes[at + i] === byte);
}

export function sniffImage(bytes: Uint8Array): ImageFormat | null {
    if (startsWith(bytes, PNG_SIGNATURE)) return "png";
    if (startsWith(bytes, JPEG_SOI)) return "jpeg";
    if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "webp";
    return null;
}
