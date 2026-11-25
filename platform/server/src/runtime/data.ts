import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import { toDataResponseBytes, toDataResponseV3Bytes } from "@lucent/wire/data";
import { type Frame, MAX_FRAME_PLAIN_SIZE, NONCE_SIZE, sealFrame } from "@lucent/wire/frame";
import type { FactDelivery } from "../facts/publishing.ts";

// Bundles reach a module as data_response plaintexts, sealed on the data route: the first in the
// session reply (server-to-module sequence 0), the rest from POST /v1/sessions/:id/data. Both go
// out in the release's format, so a module that reads version 3 has its overrides at boot.

export const FIRST_DATA_SEQUENCE = 0n;

// A new session's, as runtime_session.data_revision defaults to.
export const INITIAL_DATA_REVISION = 0n;

// The first data answers the hello, not a data-route frame.
export const FIRST_DATA_ANSWERS = 0n;

export type DataTooLarge = { readonly code: "DATA_TOO_LARGE"; readonly size: number };

// Which data response a release's module reads, and for version 3 the release's signed override
// document as stored (null before its first switch).
export type DataFormat =
    | { readonly version: 2 }
    | { readonly version: 3; readonly overrides: Uint8Array | null };

const V2: DataFormat = { version: 2 };

// The one place a release's data response version is chosen. Every release reads version 2 for
// now: which releases' modules read version 3 is a field of the release manifest that waits on the
// human, and version 3 carries the stored document that OVERRIDE_SIGNING_KEY signs, which config
// doesn't read yet. Both land here, and only here.
export function dataFormatOf(_releaseId: Uint8Array): DataFormat {
    return V2;
}

// The response's plaintext, built where a response too large for a frame is still a refusal: the
// callers assemble it before they write anything a refusal would strand (a consumed start, a
// receipt), and seal it after.
export function assembleData(params: {
    // The sequence of the module's data-route frame this answers.
    readonly answers: bigint;
    // The session's, as its lease carries it.
    readonly dataRevision: bigint;
    readonly delivery: FactDelivery;
    readonly format: DataFormat;
}): Result<Uint8Array<ArrayBuffer>, DataTooLarge> {
    const { bundle, unsupported } = params.delivery;
    const { format } = params;
    const carried = format.version === 3 ? format.overrides : null;
    const parts = bundle.byteLength + (carried?.byteLength ?? 0);
    if (parts > MAX_FRAME_PLAIN_SIZE) {
        return err({ code: "DATA_TOO_LARGE", size: parts });
    }
    const fields = {
        answers: params.answers,
        dataRevision: params.dataRevision,
        bundle,
        unsupported,
    };
    const plain =
        format.version === 2
            ? toDataResponseBytes(fields)
            : toDataResponseV3Bytes({ ...fields, overrides: carried });
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
