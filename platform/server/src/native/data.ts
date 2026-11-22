import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import { toDataResponseBytes } from "@lucent/wire/data";
import { type Frame, MAX_FRAME_PLAIN_SIZE, NONCE_SIZE, sealFrame } from "@lucent/wire/frame";
import type { FactDelivery } from "./fact-sets.ts";

// Bundles reach a module as data_response plaintexts, sealed on the data route: the first in the
// session reply (server-to-module sequence 0), the rest from POST /v1/sessions/:id/data.

// No live revisions exist yet, so every response names the empty one (the lease's data_revision
// says the same).
export const NO_DATA_REVISION = 0n;

export const FIRST_DATA_SEQUENCE = 0n;

// The first data answers the hello, not a data-route frame.
export const FIRST_DATA_ANSWERS = 0n;

export type DataTooLarge = { readonly code: "DATA_TOO_LARGE"; readonly size: number };

// The response's plaintext, built where a response too large for a frame is still a refusal: the
// callers assemble it before they write anything a refusal would strand (a consumed start, a
// receipt), and seal it after.
export function assembleData(params: {
    // The sequence of the module's data-route frame this answers.
    readonly answers: bigint;
    readonly delivery: FactDelivery;
}): Result<Uint8Array<ArrayBuffer>, DataTooLarge> {
    const { bundle, unsupported } = params.delivery;
    if (bundle.byteLength > MAX_FRAME_PLAIN_SIZE) {
        return err({ code: "DATA_TOO_LARGE", size: bundle.byteLength });
    }
    const plain = toDataResponseBytes({
        answers: params.answers,
        dataRevision: NO_DATA_REVISION,
        bundle,
        unsupported,
    });
    if (plain.byteLength > MAX_FRAME_PLAIN_SIZE) {
        return err({ code: "DATA_TOO_LARGE", size: plain.byteLength });
    }
    return ok(plain);
}

// Seals and wipes the plaintext.
export function sealData(params: {
    readonly rng: CryptoRng;
    readonly key: Uint8Array;
    readonly session: Uint8Array;
    readonly sequence: bigint;
    readonly plain: Uint8Array<ArrayBuffer>;
}): Frame {
    const frame = sealFrame(params.key, {
        header: {
            session: params.session,
            direction: "server_to_module",
            sequence: params.sequence,
        },
        nonce: params.rng.fillBytes(new Uint8Array(NONCE_SIZE)),
        plain: params.plain,
    });
    params.plain.fill(0);
    return frame;
}
