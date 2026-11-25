import { beforeAll, describe, expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createDecoderSlots, transcodeAvatar } from "../src/adapters/image/image.ts";
import {
    openDecoder,
    openEncoder,
    WASM_MEMORY_MAX_BYTES,
} from "../src/adapters/image/transcode.ts";
import { capWasmMemory } from "../src/adapters/image/wasm-memory.ts";

// Fixtures in tests/fixtures/image were written once with the pinned codecs' own encoders, then
// edited by hand: metadata chunks spliced in (each holding a LUCENT-SECRET marker), a header's
// dimensions patched (too-wide.jpg, bomb.png, frame-too-large.webp), a tail cut off
// (truncated.png), an Exif Orientation of 6 spliced into orientation-6.jpg.

const FIXTURES = new URL("./fixtures/image/", import.meta.url);
const NEVER_ANSWERS = Bun.fileURLToPath(new URL("never-answers.ts", FIXTURES));
const PAGE = 64 * 1024;

function fixture(name: string): Promise<Uint8Array> {
    return Bun.file(Bun.fileURLToPath(new URL(name, FIXTURES))).bytes();
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

// Outputs are read back with the child's own (capped) WebP decoder, in this process.
let decodeWebp: (bytes: Uint8Array) => Promise<unknown> = () => Promise.resolve(null);

async function decoded(webp: Uint8Array) {
    const image = await decodeWebp(webp);
    invariant(typeof image === "object" && image !== null, "decoded");
    invariant("width" in image && "height" in image && "data" in image, "image data");
    const { width, height, data } = image;
    invariant(typeof width === "number" && typeof height === "number", "sized");
    invariant(data instanceof Uint8ClampedArray, "rgba");
    return { width, height, data };
}

function pixel(
    image: { readonly width: number; readonly data: Uint8ClampedArray },
    x: number,
    y: number,
) {
    const at = (y * image.width + x) * 4;
    return [...image.data.subarray(at, at + 3)];
}

beforeAll(async () => {
    const webp = await openDecoder("webp");
    invariant(webp.ok, "the WebP decoder opens");
    decodeWebp = webp.value.run;
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
            entry: NEVER_ANSWERS,
            deadlineMs: 1_000,
        });
        const elapsed = performance.now() - startedAt;
        expect(result).toEqual({ ok: false, error: { code: "IMAGE_TIMED_OUT" } });
        expect(elapsed).toBeGreaterThanOrEqual(1_000);
        expect(elapsed).toBeLessThan(3_000);
    });

    test("whose animation frame claims more than its canvas is refused before decoding", async () => {
        expect(await transcodeAvatar(await fixture("frame-too-large.webp"))).toEqual({
            ok: false,
            error: { code: "IMAGE_TOO_LARGE" },
        });
    });

    // Stored 64 x 32 with red at the top left; turned clockwise it shows red at the top right.
    test("a JPEG is turned upright by its Exif orientation before it is cropped", async () => {
        const result = await transcodeAvatar(await fixture("orientation-6.jpg"));
        invariant(result.ok, `transcoded: ${JSON.stringify(result)}`);
        const image = await decoded(result.value.small);
        const [r, , b] = pixel(image, 56, 4);
        expect(r).toBeGreaterThan(200);
        expect(b).toBeLessThan(60);
        const [r2, , b2] = pixel(image, 8, 4);
        expect(r2).toBeLessThan(60);
        expect(b2).toBeGreaterThan(200);
        expect(contains(result.value.large, "Exif")).toBe(false);
    });

    test("whose codec won't load is the server's failure, with what the child said", async () => {
        const result = await transcodeAvatar(await fixture("metadata.png"), {
            entry: Bun.fileURLToPath(new URL("broken-codec-child.ts", FIXTURES)),
        });
        invariant(!result.ok && result.error.code === "IMAGE_CODEC_FAILED", JSON.stringify(result));
        expect(result.error.detail).toContain("not wasm");
    });
});

describe("the decoder slots", () => {
    test("a third upload waits for a slot, so no more than two children ever run", async () => {
        const slots = createDecoderSlots({ limit: 2, waitMs: 2_000 });
        const png = await fixture("metadata.png");
        const startedAt = performance.now();
        const finished = await Promise.all(
            [0, 1, 2].map(async () => {
                const result = await transcodeAvatar(png, {
                    entry: NEVER_ANSWERS,
                    deadlineMs: 700,
                    slots,
                });
                return { result, at: performance.now() - startedAt };
            }),
        );
        expect(finished.map((f) => f.result)).toEqual(
            [0, 1, 2].map(() => ({ ok: false, error: { code: "IMAGE_TIMED_OUT" } })),
        );
        const [first, second, third] = finished.map((f) => f.at).sort((a, b) => a - b);
        invariant(first !== undefined && second !== undefined && third !== undefined, "three");
        // Two ran side by side; the third began only once one of them was killed.
        expect(second).toBeLessThan(first + 500);
        expect(third).toBeGreaterThanOrEqual(first + 650);
    }, 10_000);

    test("a caller still waiting when the wait ends is refused without a child", async () => {
        const slots = createDecoderSlots({ limit: 2, waitMs: 200 });
        const png = await fixture("metadata.png");
        const holding = [0, 1].map(() =>
            transcodeAvatar(png, { entry: NEVER_ANSWERS, deadlineMs: 1_500, slots }),
        );
        const startedAt = performance.now();
        // A child here would fail to start its missing script and answer otherwise.
        const refused = await transcodeAvatar(png, { entry: "no-such-child.ts", slots });
        expect(refused).toEqual({ ok: false, error: { code: "IMAGE_BUSY" } });
        expect(performance.now() - startedAt).toBeLessThan(1_000);
        await Promise.all(holding);
    }, 10_000);
});

describe("the codecs' WebAssembly", () => {
    // The memory each codec actually runs on, opened the way the child opens it: growing it past
    // the cap fails, which an uncapped build (2 GiB, or none for PNG) would allow.
    test.each([
        ["jpeg", "metadata.jpg"],
        ["png", "metadata.png"],
        ["webp", "metadata.webp"],
    ] as const)("the %s decoder runs on memory capped at 640 MiB", async (format, name) => {
        const decoder = await openDecoder(format);
        invariant(decoder.ok, `opened: ${JSON.stringify(decoder)}`);
        await decoder.value.run(await fixture(name));
        const memory = decoder.value.memory();
        invariant(memory !== null, "the codec's instance has a memory");
        const pages = memory.buffer.byteLength / PAGE;
        expect(() => memory.grow(WASM_MEMORY_MAX_BYTES / PAGE - pages + 1)).toThrow();
    });

    test("the WebP encoder runs on memory capped at 640 MiB", async () => {
        const encoder = await openEncoder();
        invariant(encoder.ok, `opened: ${JSON.stringify(encoder)}`);
        await encoder.value.run({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
        const memory = encoder.value.memory();
        invariant(memory !== null, "the codec's instance has a memory");
        const pages = memory.buffer.byteLength / PAGE;
        expect(() => memory.grow(WASM_MEMORY_MAX_BYTES / PAGE - pages + 1)).toThrow();
    });

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
