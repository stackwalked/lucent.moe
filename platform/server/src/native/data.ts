import type { CryptoRng } from "@lucent/core/rng";
import { toDataResponseBytes } from "@lucent/wire/data";
import { type Frame, NONCE_SIZE, sealFrame } from "@lucent/wire/frame";
import type { FactDelivery } from "./fact-sets.ts";

// Bundles reach a module as data_response plaintexts, sealed on the data route: the first in the
// session reply (server-to-module sequence 0), the rest from POST /v1/sessions/:id/data.

// No live revisions exist yet, so every response names the empty one (the lease's data_revision
// says the same).
export const NO_DATA_REVISION = 0n;

export const FIRST_DATA_SEQUENCE = 0n;

// The first data answers the hello, not a data-route frame.
export const FIRST_DATA_ANSWERS = 0n;

export function sealedData(params: {
    readonly rng: CryptoRng;
    readonly key: Uint8Array;
    readonly session: Uint8Array;
    readonly sequence: bigint;
    // The sequence of the module's data-route frame this answers.
    readonly answers: bigint;
    readonly delivery: FactDelivery;
}): Frame {
    const plain = toDataResponseBytes({
        answers: params.answers,
        dataRevision: NO_DATA_REVISION,
        bundle: params.delivery.bundle,
        unsupported: params.delivery.unsupported,
    });
    const frame = sealFrame(params.key, {
        header: {
            session: params.session,
            direction: "server_to_module",
            sequence: params.sequence,
        },
        nonce: params.rng.fillBytes(new Uint8Array(NONCE_SIZE)),
        plain,
    });
    plain.fill(0);
    return frame;
}
