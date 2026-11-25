import { beforeAll, describe, expect, test } from "bun:test";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import { invariant } from "@lucent/core/contain";
import { transcodeAvatar } from "../src/adapters/image/image.ts";
import {
    instantiateFrom,
    WASM_FILES,
    WASM_MEMORY_MAX_BYTES,
} from "../src/adapters/image/transcode.ts";
import { capWasmMemory } from "../src/adapters/image/wasm-memory.ts";

// Fixtures in tests/fixtures/image were written once with the pinned codecs' own encoders, then
// edited by hand: metadata chunks spliced in (each holding a LUCENT-SECRET marker), a header's
// dimensions patched (too-wide.jpg, bomb.png), a tail cut off (truncated.png).

const FIXTURES = new URL("./fixtures/image/", import.meta.url);
const PAGE = 64 * 1024;

function fixture(name: string): Promise<Uint8Array> {
    return Bun.file(Bun.fileURLToPath(new URL(name, FIXTURES))).bytes();
}

function wasmBytes(file: string): Promise<Uint8Array> {
    return Bun.file(Bun.fileURLToPath(import.meta.resolve(file))).bytes();
}

function contains(haystack: Uint8Array, needle: string): boolean {
    return new TextDecoder("latin1").decode(haystack).includes(needle);
}

// The RIFF chunk ids at the top level of a WebP.
function chunkIds(webp: Uint8Array): string[] {
    const ids: string[] = [];
    const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
    for (let at = 12; at + 8 <= webp.length; ) {
        ids.push(new TextDecoder().decode(webp.subarray(at, at + 4)));
        const size = view.getUint32(at + 4, true);
        at += 8 + size + (size % 2);
    }
    return ids;
}

async function decoded(webp: Uint8Array) {
    const image = await decodeWebp(webp.slice().buffer);
    const { width, height, data } = image;
    invariant(data instanceof Uint8ClampedArray, "rgba");
    return { width, height, data };
}

beforeAll(async () => {
    await initWebpDecode(instantiateFrom(new WebAssembly.Module(await wasmBytes(WASM_FILES.webp))));
});

describe("an avatar upload", () => {
    test.each([
        ["metadata.jpg", "JPEG"],
        ["metadata.png", "PNG"],
        ["metadata.webp", "WEBP"],
    ])("%s becomes a 256 and a 64 px square WebP with none of its metadata", async (name, tag) => {
        const input = await fixture(name);
        expect(contains(input, `LUCENT-SECRET-${tag}`)).toBe(true);
        const result = await transcodeAvatar(input);
        invariant(result.ok, `transcoded: ${JSON.stringify(result)}`);
        for (const [webp, side] of [
            [result.value.large, 256],
            [result.value.small, 64],
        ] as const) {
            expect(contains(webp, "LUCENT-SECRET")).toBe(false);
            expect(
                chunkIds(webp).filter((id) => !["VP8 ", "VP8L", "VP8X", "ALPH"].includes(id)),
            ).toEqual([]);
            const image = await decoded(webp);
            expect([image.width, image.height]).toEqual([side, side]);
        }
    });

    test("is told apart by its bytes, whatever its name says", async () => {
        const result = await transcodeAvatar(await fixture("png-named.jpg"));
        expect(result.ok).toBe(true);
        expect(await transcodeAvatar(await fixture("not-an-image.png"))).toEqual({
            ok: false,
            error: { code: "NOT_AN_IMAGE" },
        });
    });

    test("cut short is refused as undecodable", async () => {
        expect(await transcodeAvatar(await fixture("truncated.png"))).toEqual({
            ok: false,
            error: { code: "IMAGE_UNDECODABLE" },
        });
    });

    test("whose header claims more than 4096 px a side is refused as too large", async () => {
        expect(await transcodeAvatar(await fixture("too-wide.jpg"))).toEqual({
            ok: false,
            error: { code: "IMAGE_TOO_LARGE" },
        });
    });

    // 60000 x 60000 RGBA would be 14 GB. A decoder that tried would fail to allocate under its cap
    // and answer undecodable; too large means the header read refused it first.
    test("a small file declaring a huge canvas is refused from its header", async () => {
        const bomb = await fixture("bomb.png");
        expect(bomb.length).toBeLessThan(4096);
        expect(await transcodeAvatar(bomb)).toEqual({
            ok: false,
            error: { code: "IMAGE_TOO_LARGE" },
        });
    });

    test("over 512 KiB is refused before any child starts", async () => {
        const big = new Uint8Array(512 * 1024 + 1);
        big.set(await fixture("metadata.png"));
        expect(await transcodeAvatar(big, { entry: "no-such-child.ts" })).toEqual({
            ok: false,
            error: { code: "IMAGE_TOO_LARGE" },
        });
    });

    test("that is animated keeps its first frame only", async () => {
        const result = await transcodeAvatar(await fixture("animated.webp"));
        invariant(result.ok, `transcoded: ${JSON.stringify(result)}`);
        const image = await decoded(result.value.small);
        const centre = (32 * 64 + 32) * 4;
        const [r, g, b] = image.data.subarray(centre, centre + 3);
        expect(r).toBeGreaterThan(200);
        expect(g).toBeLessThan(40);
        expect(b).toBeLessThan(40);
    });

    test("whose decoder never answers is killed at the deadline", async () => {
        const startedAt = performance.now();
        const result = await transcodeAvatar(await fixture("metadata.png"), {
            entry: Bun.fileURLToPath(new URL("never-answers.ts", FIXTURES)),
            deadlineMs: 1_000,
        });
        const elapsed = performance.now() - startedAt;
        expect(result).toEqual({ ok: false, error: { code: "IMAGE_TIMED_OUT" } });
        expect(elapsed).toBeGreaterThanOrEqual(1_000);
        expect(elapsed).toBeLessThan(3_000);
    });
});

describe("the codecs' WebAssembly", () => {
    test.each(Object.values(WASM_FILES))(
        "%s cannot grow its memory past 640 MiB once capped",
        async (file) => {
            const capped = capWasmMemory(await wasmBytes(file), WASM_MEMORY_MAX_BYTES);
            invariant(capped.ok, `capped: ${JSON.stringify(capped)}`);
            const module = new WebAssembly.Module(capped.value);
            const imports: Record<string, Record<string, () => number>> = {};
            for (const entry of WebAssembly.Module.imports(module)) {
                invariant(entry.kind === "function", `only functions are imported: ${entry.name}`);
                imports[entry.module] = { ...imports[entry.module], [entry.name]: () => 0 };
            }
            const instance = new WebAssembly.Instance(module, imports);
            const memory = Object.values(instance.exports).find(
                (value) => value instanceof WebAssembly.Memory,
            );
            invariant(memory instanceof WebAssembly.Memory, "the module exports its memory");
            const pages = memory.buffer.byteLength / PAGE;
            expect(() => memory.grow(WASM_MEMORY_MAX_BYTES / PAGE - pages + 1)).toThrow();
        },
    );

    test("a module that imports its memory is refused rather than run uncapped", () => {
        // (module (import "env" "memory" (memory 1)))
        const imported = Uint8Array.from([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x02, 0x0f, 0x01, 0x03, 0x65, 0x6e,
            0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x01,
        ]);
        expect(WebAssembly.validate(imported)).toBe(true);
        expect(capWasmMemory(imported, WASM_MEMORY_MAX_BYTES).ok).toBe(false);
    });
});
