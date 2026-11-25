// Decoded RGBA, cut to its centred square and resampled to `side` by area averaging: each output
// pixel is the coverage-weighted mean of the source pixels under it, which is a box filter going
// down and close to nearest-neighbour going up. Colour is averaged premultiplied by alpha, so a
// transparent pixel's hidden colour does not bleed into its neighbours.

export type Rgba = {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8Array | Uint8ClampedArray;
};

type Tap = { readonly index: number; readonly weight: number };

// For each output index, the source indices under it and how much of each, summing to one.
function taps(sourceLength: number, outputLength: number): readonly (readonly Tap[])[] {
    const scale = sourceLength / outputLength;
    return Array.from({ length: outputLength }, (_, o) => {
        const from = o * scale;
        const to = from + scale;
        const out: Tap[] = [];
        for (let i = Math.floor(from); i < Math.min(Math.ceil(to), sourceLength); i++) {
            const overlap = Math.min(to, i + 1) - Math.max(from, i);
            if (overlap > 0) out.push({ index: i, weight: overlap / scale });
        }
        return out;
    });
}

export function toSquare(image: Rgba, side: number): Rgba {
    const crop = Math.min(image.width, image.height);
    const left = Math.floor((image.width - crop) / 2);
    const top = Math.floor((image.height - crop) / 2);
    const weights = taps(crop, side);

    // Horizontal pass over the crop's rows into premultiplied floats, crop rows by `side` columns.
    const rows = new Float32Array(crop * side * 4);
    for (let y = 0; y < crop; y++) {
        const sourceRow = ((top + y) * image.width + left) * 4;
        for (let x = 0; x < side; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (const tap of weights[x] ?? []) {
                const at = sourceRow + tap.index * 4;
                const alpha = ((image.data[at + 3] ?? 0) / 255) * tap.weight;
                r += (image.data[at] ?? 0) * alpha;
                g += (image.data[at + 1] ?? 0) * alpha;
                b += (image.data[at + 2] ?? 0) * alpha;
                a += alpha;
            }
            const to = (y * side + x) * 4;
            rows[to] = r;
            rows[to + 1] = g;
            rows[to + 2] = b;
            rows[to + 3] = a;
        }
    }

    const data = new Uint8ClampedArray(side * side * 4);
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (const tap of weights[y] ?? []) {
                const at = (tap.index * side + x) * 4;
                r += (rows[at] ?? 0) * tap.weight;
                g += (rows[at + 1] ?? 0) * tap.weight;
                b += (rows[at + 2] ?? 0) * tap.weight;
                a += (rows[at + 3] ?? 0) * tap.weight;
            }
            const to = (y * side + x) * 4;
            if (a > 0) {
                data[to] = Math.round(r / a);
                data[to + 1] = Math.round(g / a);
                data[to + 2] = Math.round(b / a);
            }
            data[to + 3] = Math.round(a * 255);
        }
    }
    return { width: side, height: side, data };
}
