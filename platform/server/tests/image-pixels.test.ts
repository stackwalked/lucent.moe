import { describe, expect, test } from "bun:test";
import { readJpegOrientation } from "../src/adapters/image/header.ts";
import { orient, type Rgba, toSquare } from "../src/adapters/image/square.ts";

function image(width: number, height: number, at: (x: number, y: number) => number[]): Rgba {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) data.set(at(x, y), (y * width + x) * 4);
    }
    return { width, height, data };
}

function pixel(of: Rgba, x: number, y: number): number[] {
    const at = (y * of.width + x) * 4;
    return [...of.data.subarray(at, at + 4)];
}

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

describe("the square an avatar is cut to", () => {
    test("is the centre of a wide image, its sides cut evenly", () => {
        // 6 x 2: two blue columns either side of a red 2 x 2 middle.
        const wide = image(6, 2, (x) => (x >= 2 && x < 4 ? RED : BLUE));
        const square = toSquare(wide, 2);
        expect([square.width, square.height]).toEqual([2, 2]);
        for (const [x, y] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
        ] as const) {
            expect(pixel(square, x, y)).toEqual(RED);
        }
    });

    test("is the centre of a tall image too", () => {
        const tall = image(2, 6, (_x, y) => (y >= 2 && y < 4 ? RED : BLUE));
        expect(pixel(toSquare(tall, 1), 0, 0)).toEqual(RED);
    });

    test("enlarges a single pixel to every pixel of the square", () => {
        const one = image(1, 1, () => [10, 20, 30, 255]);
        const square = toSquare(one, 4);
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) expect(pixel(square, x, y)).toEqual([10, 20, 30, 255]);
        }
    });

    // A transparent pixel's colour is invisible and must stay so: averaged straight, the hidden
    // blue would tint the red half towards purple.
    test("does not let the colour under a transparent pixel bleed into its neighbours", () => {
        const half = image(2, 2, (x) => (x === 0 ? RED : [0, 0, 255, 0]));
        const [r, g, b, a] = pixel(toSquare(half, 1), 0, 0);
        expect([r, g, b]).toEqual([255, 0, 0]);
        expect(a).toBe(128);
    });
});

describe("an Exif orientation applied to the pixels", () => {
    // 3 x 2 with a red top-left corner. Each orientation's displayed image has the red pixel at
    // the place TIFF 6.0 says the stored top-left goes.
    const stored = image(3, 2, (x, y) => (x === 0 && y === 0 ? RED : BLUE));
    test.each([
        [1, 3, 2, [0, 0]],
        [2, 3, 2, [2, 0]],
        [3, 3, 2, [2, 1]],
        [4, 3, 2, [0, 1]],
        [5, 2, 3, [0, 0]],
        [6, 2, 3, [1, 0]],
        [7, 2, 3, [1, 2]],
        [8, 2, 3, [0, 2]],
    ] as const)("%i shows %ix%i with the stored top-left at %j", (o, width, height, [x, y]) => {
        const turned = orient(stored, o);
        expect([turned.width, turned.height]).toEqual([width, height]);
        expect(pixel(turned, x, y)).toEqual(RED);
    });
});

describe("the orientation a JPEG asks for", () => {
    const tiff = (value: number) => [
        0x4d,
        0x4d,
        0x00,
        0x2a,
        0x00,
        0x00,
        0x00,
        0x08,
        0x00,
        0x01,
        0x01,
        0x12,
        0x00,
        0x03,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        value,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
    ];
    const exif = (body: number[]) => {
        const payload = [...new TextEncoder().encode("Exif\0\0"), ...body];
        const length = payload.length + 2;
        return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...payload]);
    };

    test("is read from IFD0 of its Exif segment", () => {
        expect(readJpegOrientation(exif(tiff(6)))).toBe(6);
        expect(readJpegOrientation(exif(tiff(8)))).toBe(8);
    });

    test.each([
        ["no Exif at all", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
        ["a value out of range", exif(tiff(9))],
        ["a TIFF cut short", exif(tiff(6).slice(0, 14))],
        ["an unknown byte order", exif([0x41, 0x41, ...tiff(6).slice(2)])],
        [
            "a segment length past the file",
            Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45]),
        ],
    ])("is as stored for %s", (_name, bytes) => {
        expect(readJpegOrientation(bytes)).toBe(1);
    });
});
