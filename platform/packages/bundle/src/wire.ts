import { invariant } from "@lucent/core/contain";
import { type Err, err } from "@lucent/core/result";

// Little-endian, fixed-width encoding for the fact containers; nothing in it is aligned or padded.
// Mirrors native/libs/bundle/src/wire.hpp.

// A format this build doesn't read is a version mismatch; anything else wrong is malformed.
export type FormatError = { readonly code: "MALFORMED" } | { readonly code: "VERSION_MISMATCH" };

export const malformed = (): Err<FormatError> => err({ code: "MALFORMED" });
export const versionMismatch = (): Err<FormatError> => err({ code: "VERSION_MISMATCH" });

// Reads past the end are bugs, not refusals: a decoder checks `remaining()` before every
// fixed-size run of fields, then reads them without a check each.
export type Reader = {
    readonly remaining: () => number;
    readonly u8: () => number;
    readonly u16: () => number;
    readonly u32: () => number;
    readonly u64: () => bigint;
    readonly bytes: (count: number) => Uint8Array<ArrayBuffer>;
};

export function openReader(input: Uint8Array): Reader {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    let offset = 0;
    const take = (width: number): number => {
        invariant(width <= input.byteLength - offset, "decoder read past the end unchecked");
        const at = offset;
        offset += width;
        return at;
    };
    return {
        remaining: () => input.byteLength - offset,
        u8: () => view.getUint8(take(1)),
        u16: () => view.getUint16(take(2), true),
        u32: () => view.getUint32(take(4), true),
        u64: () => view.getBigUint64(take(8), true),
        bytes: (count) => {
            const at = take(count);
            return input.slice(at, at + count);
        },
    };
}

export type Writer = {
    readonly u8: (value: number) => void;
    readonly u16: (value: number) => void;
    readonly u32: (value: number) => void;
    readonly u64: (value: bigint) => void;
    readonly bytes: (value: Uint8Array) => void;
    readonly finish: () => Uint8Array<ArrayBuffer>;
};

export function createWriter(): Writer {
    let buffer = new Uint8Array(256);
    let view = new DataView(buffer.buffer);
    let length = 0;
    // Callers take the offset before touching `buffer` or `view`: reserving may replace both.
    const reserve = (width: number): number => {
        if (length + width > buffer.byteLength) {
            const grown = new Uint8Array(Math.max(buffer.byteLength * 2, length + width));
            grown.set(buffer.subarray(0, length));
            buffer = grown;
            view = new DataView(buffer.buffer);
        }
        const at = length;
        length += width;
        return at;
    };
    return {
        u8: (value) => {
            invariant(Number.isInteger(value) && value >= 0 && value <= 0xff, "u8 out of range");
            const at = reserve(1);
            view.setUint8(at, value);
        },
        u16: (value) => {
            invariant(Number.isInteger(value) && value >= 0 && value <= 0xffff, "u16 out of range");
            const at = reserve(2);
            view.setUint16(at, value, true);
        },
        u32: (value) => {
            invariant(
                Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff,
                "u32 out of range",
            );
            const at = reserve(4);
            view.setUint32(at, value, true);
        },
        u64: (value) => {
            invariant(value >= 0n && value <= 0xffff_ffff_ffff_ffffn, "u64 out of range");
            const at = reserve(8);
            view.setBigUint64(at, value, true);
        },
        bytes: (value) => {
            const at = reserve(value.byteLength);
            buffer.set(value, at);
        },
        finish: () => buffer.slice(0, length),
    };
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) {
        return false;
    }
    return left.every((value, index) => value === right[index]);
}
