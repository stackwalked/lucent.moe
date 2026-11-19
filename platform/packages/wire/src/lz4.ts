// LZ4's block format (lz4/doc/lz4_Block_format.md), decompression only: what the native build's
// LZ4 1.11.1 writes into a packed container. The server reads containers only to check them at
// publish time, so it needs no compressor and takes no dependency for one.

function readLength(input: Uint8Array, start: number, nibble: number): [number, number] | null {
    let length = nibble;
    let at = start;
    if (nibble !== 15) return [length, at];
    for (;;) {
        const next = input[at];
        if (next === undefined) return null;
        at += 1;
        length += next;
        if (next !== 255) return [length, at];
    }
}

// Exactly `size` bytes out, every input byte used; anything else is null.
export function decompressLz4Block(input: Uint8Array, size: number): Uint8Array | null {
    const out = new Uint8Array(size);
    let read = 0;
    let written = 0;
    while (read < input.byteLength) {
        const token = input[read] ?? 0;
        read += 1;
        const literals = readLength(input, read, token >> 4);
        if (literals === null) return null;
        const [literalLength, afterLength] = literals;
        read = afterLength;
        if (read + literalLength > input.byteLength || written + literalLength > size) return null;
        out.set(input.subarray(read, read + literalLength), written);
        read += literalLength;
        written += literalLength;
        // The last sequence is literals only.
        if (read === input.byteLength) break;
        if (read + 2 > input.byteLength) return null;
        const offset = (input[read] ?? 0) | ((input[read + 1] ?? 0) << 8);
        read += 2;
        if (offset === 0 || offset > written) return null;
        const match = readLength(input, read, token & 15);
        if (match === null) return null;
        const [matchLength, afterMatch] = match;
        read = afterMatch;
        const length = matchLength + 4;
        if (written + length > size) return null;
        // Byte by byte: a match may overlap the bytes it is copying.
        for (let index = 0; index < length; index += 1) {
            out[written] = out[written - offset] ?? 0;
            written += 1;
        }
    }
    return written === size ? out : null;
}
