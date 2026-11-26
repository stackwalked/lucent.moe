import { err, ok, type Result } from "@lucent/core/result";

// The codecs' WebAssembly declares its own linear memory (jsquash jpeg 1.6.0 and webp 1.5.0 ship
// Emscripten builds with a 2 GiB maximum; png 3.1.1 ships a wasm-bindgen build with none). None
// imports its memory, so the cap is written into the binary's memory section before it is
// compiled: a decoder that asks for more fails its allocation inside WebAssembly instead of
// taking the host's memory. Checked by reading each pinned binary's sections (2026-11-25); a
// build that imports its memory, or declares a shared or 64-bit one, is refused here rather
// than run uncapped.

export type WasmRewriteFailure = { readonly code: "WASM_UNSUPPORTED"; readonly detail: string };

const PAGE_BYTES = 64 * 1024;
const MEMORY_SECTION = 5;
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

type Leb = { readonly value: number; readonly next: number };

function readLeb(bytes: Uint8Array, at: number): Leb | null {
    let value = 0;
    let shift = 0;
    for (let p = at; p < bytes.length && shift < 35; p++) {
        const byte = bytes[p] ?? 0;
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if ((byte & 0x80) === 0) return { value, next: p + 1 };
    }
    return null;
}

function writeLeb(value: number): number[] {
    const out: number[] = [];
    let rest = value;
    do {
        const low = rest % 128;
        rest = Math.floor(rest / 128);
        out.push(rest === 0 ? low : low | 0x80);
    } while (rest !== 0);
    return out;
}

function unsupported(detail: string): Result<never, WasmRewriteFailure> {
    return err({ code: "WASM_UNSUPPORTED", detail });
}

function cappedMemorySection(
    payload: Uint8Array,
    maxPages: number,
): Result<number[], WasmRewriteFailure> {
    const count = readLeb(payload, 0);
    if (count === null || count.value !== 1) return unsupported("not exactly one memory");
    const flags = payload[count.next];
    if (flags !== 0x00 && flags !== 0x01) return unsupported(`memory limits flags ${flags}`);
    const min = readLeb(payload, count.next + 1);
    if (min === null) return unsupported("memory minimum unreadable");
    const declared = flags === 0x01 ? readLeb(payload, min.next) : null;
    if (flags === 0x01 && declared === null) return unsupported("memory maximum unreadable");
    const end = declared?.next ?? min.next;
    if (end !== payload.length) return unsupported("memory section has trailing bytes");
    const max = Math.min(declared?.value ?? maxPages, maxPages);
    if (min.value > max) return unsupported(`memory minimum ${min.value} pages over the cap`);
    return ok([...writeLeb(1), 0x01, ...writeLeb(min.value), ...writeLeb(max)]);
}

// The module with its one memory's maximum lowered to `maxBytes` (whole pages), every other
// section byte for byte.
export function capWasmMemory(
    module: Uint8Array,
    maxBytes: number,
): Result<Uint8Array, WasmRewriteFailure> {
    if (!HEADER.every((byte, i) => module[i] === byte)) return unsupported("not wasm 1");
    const maxPages = Math.floor(maxBytes / PAGE_BYTES);
    const parts: Uint8Array[] = [module.subarray(0, HEADER.length)];
    let rewritten = false;
    let at = HEADER.length;
    while (at < module.length) {
        const id = module[at] ?? 0;
        const size = readLeb(module, at + 1);
        if (size === null || size.next + size.value > module.length) {
            return unsupported("section runs past the end");
        }
        const end = size.next + size.value;
        if (id !== MEMORY_SECTION) {
            parts.push(module.subarray(at, end));
            at = end;
            continue;
        }
        const payload = cappedMemorySection(module.subarray(size.next, end), maxPages);
        if (!payload.ok) return payload;
        parts.push(Uint8Array.from([id, ...writeLeb(payload.value.length), ...payload.value]));
        rewritten = true;
        at = end;
    }
    if (!rewritten) return unsupported("no memory section: memory is imported or absent");
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return ok(out);
}
