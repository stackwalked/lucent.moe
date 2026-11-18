export type CryptoRng = {
    readonly fillBytes: (target: Uint8Array) => Uint8Array;
};

export type SeededRng = CryptoRng & {
    readonly nextUint32: () => number;
};

// The one ambient source of randomness (ast-grep: ts-no-ambient-randomness); everything else
// takes a CryptoRng.
export const systemCryptoRng: CryptoRng = {
    fillBytes: (target) => crypto.getRandomValues(target),
};

// Deterministic splitmix32 stream for tests and seeded format logic.
export function createSeededRng(seed: number): SeededRng {
    let state = seed >>> 0;
    const nextUint32 = (): number => {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
        return (z ^ (z >>> 16)) >>> 0;
    };
    return {
        nextUint32,
        fillBytes(target: Uint8Array): Uint8Array {
            let i = 0;
            while (i < target.byteLength) {
                const word = nextUint32();
                target[i] = word & 0xff;
                if (i + 1 < target.byteLength) target[i + 1] = (word >>> 8) & 0xff;
                if (i + 2 < target.byteLength) target[i + 2] = (word >>> 16) & 0xff;
                if (i + 3 < target.byteLength) target[i + 3] = (word >>> 24) & 0xff;
                i += 4;
            }
            return target;
        },
    };
}
