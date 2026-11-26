// What the decoder child writes to stdout, the whole of it, then exits:
//   0x00, u32le length, the 256 px WebP, u32le length, the 64 px WebP; or
//   0x01, one refusal byte.
// Anything else (a short frame, trailing bytes, a non-zero exit) is the child failing, which the
// parent answers as undecodable.

// What both sides hold an upload to. The byte bound is the parent's, enforced while streaming and
// again in the child; the side bound is the child's, read from the header before decoding.
export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_MAX_SIDE = 4096;
// The two squares an avatar is stored as, in pixels: the profile's and the author line's.
export const AVATAR_SIDES = [256, 64] as const;

// The one rectangle a profile banner is stored as. In banner mode the frame's large slot carries
// it and the small slot is empty; the parent knows which mode it asked for.
export const BANNER_WIDTH = 1500;
export const BANNER_HEIGHT = 400;

// A refusal's byte is its place in this list plus one.
// CODEC_FAILED is the child's own fault (a codec that would not load, instantiate or encode good
// pixels), not the upload's; the child says why on stderr.
const CHILD_REFUSALS = ["TOO_LARGE", "NOT_AN_IMAGE", "UNDECODABLE", "CODEC_FAILED"] as const;

export type ChildRefusal = (typeof CHILD_REFUSALS)[number];

export type ChildAnswer =
    | { readonly ok: true; readonly large: Uint8Array; readonly small: Uint8Array }
    | {
          readonly ok: false;
          readonly refusal: ChildRefusal;
          // Why, for the child's stderr; never part of the frame.
          readonly detail?: string;
      };

function u32le(value: number): number[] {
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function toChildFrame(answer: ChildAnswer): Uint8Array {
    if (!answer.ok) return Uint8Array.from([0x01, CHILD_REFUSALS.indexOf(answer.refusal) + 1]);
    const out = new Uint8Array(1 + 4 + answer.large.length + 4 + answer.small.length);
    out.set([0x00, ...u32le(answer.large.length)], 0);
    out.set(answer.large, 5);
    const at = 5 + answer.large.length;
    out.set(u32le(answer.small.length), at);
    out.set(answer.small, at + 4);
    return out;
}

function readU32le(bytes: Uint8Array, at: number): number | null {
    if (bytes.length < at + 4) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(at, true);
}

export function parseChildFrame(bytes: Uint8Array): ChildAnswer | null {
    if (bytes[0] === 0x01 && bytes.length === 2) {
        const refusal = CHILD_REFUSALS[(bytes[1] ?? 0) - 1];
        return refusal === undefined ? null : { ok: false, refusal };
    }
    if (bytes[0] !== 0x00) return null;
    const largeLength = readU32le(bytes, 1);
    if (largeLength === null) return null;
    const smallAt = 5 + largeLength;
    const smallLength = readU32le(bytes, smallAt);
    if (smallLength === null || smallAt + 4 + smallLength !== bytes.length) return null;
    return {
        ok: true,
        large: bytes.slice(5, smallAt),
        small: bytes.slice(smallAt + 4),
    };
}
