import type { ReleaseManifestV3 } from "@lucent/bundle/release-manifest";
import type { CryptoRng } from "@lucent/core/rng";
import { type Frame, NONCE_SIZE, sealFrame } from "@lucent/wire/frame";
import {
    CHALLENGE_NONCE_SIZE,
    type EntitledFeatures,
    type HashChallenge,
    toLeaseBytes,
    toLeaseSignedBytes,
} from "@lucent/wire/lease";
import { toLeaseResponseBytes } from "@lucent/wire/lease-exchange";
import { toExchangeSignedBytes, toSessionReplyBytes } from "@lucent/wire/session";
import type { FeatureSelection } from "../../identity/authority/entitlements.ts";
import type { LeaseSigner } from "./lease-key.ts";

// The lease and what it carries, as the server signs and seals it for the module. Renewed every
// 15 seconds, valid for 60 counted on the module's monotonic clock from its request. A session runs
// at most 12 hours (a replaced release stays servable until its sessions end), and one whose lease
// lapsed resumes if it renews within 5 minutes and nobody took the slot meanwhile; past that it has
// unloaded.

export const LEASE_DURATION_MS = 60 * 1_000;
export const RESUME_WINDOW_MS = 5 * 60 * 1_000;
export const SESSION_CAP_MS = 12 * 60 * 60 * 1_000;

// How much of the image one challenge names: small enough to hash between frames.
const MAX_CHALLENGE_SIZE = 4_096;

// A random range of the module's image, `[offset, offset + size)`, inside its reported size.
export function newChallenge(rng: CryptoRng, imageSize: number): HashChallenge {
    const size = Math.min(MAX_CHALLENGE_SIZE, imageSize);
    const word = new DataView(rng.fillBytes(new Uint8Array(4)).buffer).getUint32(0, true);
    return {
        nonce: new Uint8Array(rng.fillBytes(new Uint8Array(CHALLENGE_NONCE_SIZE))),
        offset: word % (imageSize - size + 1),
        size,
    };
}

// The entitlement's feature tags as this release's keyed feature ids; everything stays everything.
export function entitledFeaturesOf(
    selection: FeatureSelection,
    manifest: ReleaseManifestV3,
): EntitledFeatures {
    if (selection === "*") return { everything: true };
    const tags = new Set<string>(selection);
    return {
        everything: false,
        features: manifest.features.filter((feature) => tags.has(feature.tag)).map((f) => f.key),
    };
}

// What the server holds of a session's current lease: enough to sign it again for a retry.
export type LeaseState = {
    readonly session: Uint8Array;
    readonly device: Uint8Array;
    readonly release: Uint8Array;
    readonly product: string;
    readonly sequence: bigint;
    readonly nonce: Uint8Array;
    readonly challenge: HashChallenge;
    readonly loaderChallenge: HashChallenge;
    readonly entitled: EntitledFeatures;
    // Rises when what the data route would send the session changes (runtime/revisions.ts).
    readonly dataRevision: bigint;
    readonly keyToModule: Uint8Array;
    // The sequence of the frame carrying this lease.
    readonly frameSequence: bigint;
};

async function sealedLease(signer: LeaseSigner, rng: CryptoRng, state: LeaseState): Promise<Frame> {
    const fields = {
        session: state.session,
        device: state.device,
        release: state.release,
        sequence: state.sequence,
        nonce: state.nonce,
        durationMs: LEASE_DURATION_MS,
        dataRevision: state.dataRevision,
        challenge: state.challenge,
        product: state.product,
        entitled: state.entitled,
    };
    const signature = await signer.sign(toLeaseSignedBytes(fields));
    const plain = toLeaseBytes({ ...fields, signature });
    const frame = sealFrame(state.keyToModule, {
        header: {
            session: state.session,
            direction: "server_to_module",
            sequence: state.frameSequence,
        },
        nonce: rng.fillBytes(new Uint8Array(NONCE_SIZE)),
        plain,
    });
    plain.fill(0);
    return frame;
}

// POST /v1/starts/:id/session's reply: the server's half of the exchange, signed by the lease key
// the module carries, the first lease and the first data.
export async function toSessionReply(params: {
    readonly signer: LeaseSigner;
    readonly rng: CryptoRng;
    readonly state: LeaseState;
    readonly moduleKey: Uint8Array;
    readonly serverKey: Uint8Array;
    // The data route's first frame, a data_response, sealed by the caller.
    readonly firstData: Frame;
}): Promise<Uint8Array<ArrayBuffer>> {
    const unsigned = {
        session: params.state.session,
        moduleKey: params.moduleKey,
        nonce: params.state.nonce,
        serverKey: params.serverKey,
        signature: new Uint8Array(0),
    };
    const signature = await params.signer.sign(toExchangeSignedBytes(unsigned));
    return toSessionReplyBytes({
        exchange: { ...unsigned, signature },
        firstLease: await sealedLease(params.signer, params.rng, params.state),
        firstData: params.firstData,
    });
}

// POST /v1/sessions/:id/lease's reply: the loader's challenge in the clear for it to answer from
// outside the module, the lease sealed for the module.
export async function toLeaseResponse(params: {
    readonly signer: LeaseSigner;
    readonly rng: CryptoRng;
    readonly state: LeaseState;
}): Promise<Uint8Array<ArrayBuffer>> {
    return toLeaseResponseBytes({
        loaderChallenge: params.state.loaderChallenge,
        lease: await sealedLease(params.signer, params.rng, params.state),
    });
}
