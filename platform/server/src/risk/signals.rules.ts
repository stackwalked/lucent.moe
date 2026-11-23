import { ok, type Result } from "@lucent/core/result";

// What the server can tell from a session today, as risk_signal kinds. A signal only ever raises
// suspicion and never changes what the client sees (wishlist/protection.md, "Signals").
//
// Not here yet, because the server can't compute them: whether a challenge answer is right needs
// the server's own hash of the relocated image (native/libs/integrity's hash and its vectors in
// contracts/), and the renewal's signal bits and the module's reports have no assigned layout.
export type SignalKind = "loader_silent" | "software_device_key";

// A device key held in software rather than a TPM is a mark staff see, weighed only in
// combination with something else.
export function decideOpenSignals(params: {
    readonly storage: "tpm" | "software";
}): Result<readonly SignalKind[], never> {
    return ok(params.storage === "software" ? ["software_device_key"] : []);
}

// The loader gets its first challenge with the first lease response, which answers the renewal
// of lease 1; from the renewal of lease 2 on, every renewal it relays carries its answer, and one
// without it is silence where a healthy loader speaks.
export function decideRenewalSignals(params: {
    readonly heldSequence: bigint;
    readonly loaderAnswered: boolean;
}): Result<readonly SignalKind[], never> {
    return ok(params.heldSequence >= 2n && !params.loaderAnswered ? ["loader_silent"] : []);
}
