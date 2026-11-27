// Regenerates src/features/landing/preview.png, the link preview of the signed-out landing: the halo
// mark centred on the graphite ground, 1200x630, nothing else.
//
//   bun dev/og-image.ts        (from web/)
//
// The PNG is committed (a product asset, marked binary); run this only when the mark or the ground
// colour changes. The mark's paths are the ones in src/ui/Logo/Logo.tsx and the colours are
// graphite's ground, ink and pink-ink from src/ui/tokens.ts. No dependency: the paths are
// flattened and filled here (non-zero winding, 4x4 samples a pixel) and the PNG is written with
// the zlib that ships with the runtime.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { invariant } from "@lucent/core/contain";

const WIDTH = 1200;
const HEIGHT = 630;
const SAMPLES = 4;
const MARK_WIDTH = 480;

const GROUND = [0x06, 0x05, 0x06] as const;
const INK = [0xef, 0xe9, 0xe6] as const;
const PINK = [0xe8, 0xa3, 0xb8] as const;

// Logo.tsx's viewBox and its two paths.
const VIEW = { x: 7.1, y: 14.3, width: 49.8, height: 31.2 } as const;
const RING =
    "M49.74 22.55C51.88 22.81 53.64 23.34 54.96 24.38C56.27 25.43 57.03 27.19 56.76 29.07C56.48 30.95 55.34 32.83 53.62 34.54C51.9 36.26 49.58 37.84 46.89 39.26C44.2 40.69 41.13 41.93 37.9 42.92C34.67 43.9 31.29 44.63 28.02 45.03C24.76 45.43 21.6 45.51 18.8 45.26C15.99 45 13.52 44.41 11.55 43.45C9.58 42.48 8.04 41.07 7.43 39.25C6.83 37.44 7.3 35.49 8.37 33.83C9.44 32.17 11.11 30.65 13.25 29.22C15.4 27.79 18.03 26.49 20.95 25.38C23.86 24.27 27.07 23.36 30.31 22.75C33.55 22.13 36.82 21.81 39.84 21.86C36.86 22.31 33.69 22.99 30.58 23.89C27.48 24.8 24.43 25.92 21.72 27.2C19 28.48 16.61 29.9 14.77 31.33C12.93 32.76 11.64 34.21 11.05 35.4C10.45 36.59 10.53 37.36 10.85 37.92C11.17 38.47 11.87 39.06 13.26 39.59C14.66 40.11 16.68 40.49 19.12 40.6C21.56 40.7 24.4 40.55 27.38 40.13C30.36 39.71 33.48 39.03 36.46 38.14C39.44 37.26 42.27 36.17 44.72 34.98C47.16 33.79 49.19 32.5 50.67 31.3C52.16 30.11 53.06 29.05 53.53 28.2C53.99 27.35 54.17 26.61 53.63 25.57C53.08 24.53 51.73 23.39 49.74 22.55Z";
const GLINT =
    "M39.84 21.86Q44.7 21.1 45.24 14.35Q45.69 21.17 49.74 22.55Q45.69 22.67 45.24 29.35Q44.7 22.6 39.84 21.86Z";

type Point = readonly [number, number];
type Edge = readonly [Point, Point];

const FLATTEN_STEPS = 24;

// Absolute M, C, Q and Z only, which is all the mark uses.
function flatten(path: string): Edge[] {
    const tokens = path.match(/[MCQZ]|-?\d*\.?\d+/g) ?? [];
    const edges: Edge[] = [];
    let at: Point = [0, 0];
    let start: Point = [0, 0];
    let i = 0;
    const number = () => Number(tokens[i++]);
    const line = (to: Point) => {
        edges.push([at, to]);
        at = to;
    };
    while (i < tokens.length) {
        const command = tokens[i++];
        if (command === "M") {
            at = [number(), number()];
            start = at;
        } else if (command === "Z") {
            line(start);
        } else if (command === "C" || command === "Q") {
            const cubic = command === "C";
            // The command repeats its coordinates until the next letter.
            while (i < tokens.length && !/^[A-Z]$/.test(tokens[i] ?? "")) {
                const controls: Point[] = [[number(), number()]];
                if (cubic) controls.push([number(), number()]);
                controls.push([number(), number()]);
                const from = at;
                const end = controls[controls.length - 1];
                invariant(end !== undefined, "path ends inside a curve");
                for (let step = 1; step <= FLATTEN_STEPS; step += 1) {
                    const t = step / FLATTEN_STEPS;
                    const u = 1 - t;
                    const point: Point = cubic
                        ? [
                              u ** 3 * from[0] +
                                  3 * u * u * t * (controls[0]?.[0] ?? 0) +
                                  3 * u * t * t * (controls[1]?.[0] ?? 0) +
                                  t ** 3 * end[0],
                              u ** 3 * from[1] +
                                  3 * u * u * t * (controls[0]?.[1] ?? 0) +
                                  3 * u * t * t * (controls[1]?.[1] ?? 0) +
                                  t ** 3 * end[1],
                          ]
                        : [
                              u * u * from[0] +
                                  2 * u * t * (controls[0]?.[0] ?? 0) +
                                  t * t * end[0],
                              u * u * from[1] +
                                  2 * u * t * (controls[0]?.[1] ?? 0) +
                                  t * t * end[1],
                          ];
                    line(point);
                }
            }
        } else {
            invariant(false, `unsupported path command ${String(command)}`);
        }
    }
    return edges;
}

// How much of each pixel the path covers, 0 to 1, by non-zero winding at SAMPLES x SAMPLES points.
function coverage(edges: readonly Edge[], scale: number, left: number, top: number): Float32Array {
    const covered = new Float32Array(WIDTH * HEIGHT);
    const sub = 1 / SAMPLES;
    for (let y = 0; y < HEIGHT * SAMPLES; y += 1) {
        const py = (y + 0.5) * sub;
        const crossings: { x: number; direction: number }[] = [];
        for (const [a, b] of edges) {
            const ay = (a[1] - VIEW.y) * scale + top;
            const by = (b[1] - VIEW.y) * scale + top;
            if (ay <= py === by <= py) continue;
            const t = (py - ay) / (by - ay);
            const x = (a[0] - VIEW.x + t * (b[0] - a[0])) * scale + left;
            crossings.push({ x, direction: by > ay ? 1 : -1 });
        }
        crossings.sort((p, q) => p.x - q.x);
        let winding = 0;
        for (let c = 0; c < crossings.length - 1; c += 1) {
            winding += crossings[c]?.direction ?? 0;
            if (winding === 0) continue;
            const from = crossings[c]?.x ?? 0;
            const to = crossings[c + 1]?.x ?? 0;
            for (let x = Math.ceil(from * SAMPLES - 0.5); x < to * SAMPLES - 0.5; x += 1) {
                if (x < 0 || x >= WIDTH * SAMPLES) continue;
                const index = Math.floor(y / SAMPLES) * WIDTH + Math.floor(x / SAMPLES);
                covered[index] = (covered[index] ?? 0) + 1 / (SAMPLES * SAMPLES);
            }
        }
    }
    return covered;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

function png(rgb: Uint8Array): Uint8Array {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, WIDTH);
    view.setUint32(4, HEIGHT);
    header.set([8, 2, 0, 0, 0], 8);
    // Each row is a filter byte (0, none) and its pixels.
    const rows = new Uint8Array(HEIGHT * (1 + WIDTH * 3));
    for (let y = 0; y < HEIGHT; y += 1) {
        rows.set(rgb.subarray(y * WIDTH * 3, (y + 1) * WIDTH * 3), y * (1 + WIDTH * 3) + 1);
    }
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows, { level: 9 })),
        chunk("IEND", new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

const scale = MARK_WIDTH / VIEW.width;
const left = (WIDTH - MARK_WIDTH) / 2;
const top = (HEIGHT - VIEW.height * scale) / 2;
const ring = coverage(flatten(RING), scale, left, top);
const glint = coverage(flatten(GLINT), scale, left, top);

const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
for (let p = 0; p < WIDTH * HEIGHT; p += 1) {
    const inRing = Math.min(1, ring[p] ?? 0);
    const inGlint = Math.min(1, glint[p] ?? 0);
    for (let channel = 0; channel < 3; channel += 1) {
        const ground = GROUND[channel] ?? 0;
        // The ring first, the glint over it, as the SVG paints them.
        const withRing = ground + ((INK[channel] ?? 0) - ground) * inRing;
        pixels[p * 3 + channel] = Math.round(
            withRing + ((PINK[channel] ?? 0) - withRing) * inGlint,
        );
    }
}

const target = join(import.meta.dirname, "../src/features/landing/preview.png");
writeFileSync(target, png(pixels));
