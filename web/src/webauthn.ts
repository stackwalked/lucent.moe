import { tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CreationOptions, RequestOptions } from "@lucent/rpc/webauthn";

// The browser's own WebAuthn, through its JSON helpers (parse*OptionsFromJSON, toJSON). What
// comes back is handed to a server function as it is; platform parses and verifies it.

// "cancelled": the person dismissed the prompt or it timed out (NotAllowedError), or another
// request replaced this one (AbortError). Pages show nothing for it.
export type PasskeyFailure = "cancelled" | "failed";

function failureOf(cause: unknown): PasskeyFailure {
    const name = typeof cause === "object" && cause !== null && "name" in cause ? cause.name : null;
    return name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "failed";
}

// The options as the DOM's own JSON type: the same shape, our schema's optional fields included.
function asJson(options: RequestOptions | CreationOptions): ReturnType<typeof JSON.parse> {
    return JSON.parse(JSON.stringify(options));
}

export async function conditionalAvailable(): Promise<boolean> {
    if (typeof PublicKeyCredential === "undefined") return false;
    const available = await tryAsync(
        () => PublicKeyCredential.isConditionalMediationAvailable(),
        () => false,
    );
    return available.ok && available.value;
}

export async function assertPasskey(params: {
    readonly options: RequestOptions;
    readonly mediation?: "conditional";
    readonly signal?: AbortSignal;
}): Promise<Result<unknown, PasskeyFailure>> {
    const got = await tryAsync(
        () =>
            navigator.credentials.get({
                publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(asJson(params.options)),
                ...(params.mediation === undefined ? {} : { mediation: params.mediation }),
                ...(params.signal === undefined ? {} : { signal: params.signal }),
            }),
        failureOf,
    );
    if (!got.ok) return got;
    const credential = got.value;
    if (!(credential instanceof PublicKeyCredential)) return err("failed");
    return ok(credential.toJSON());
}

export async function createPasskey(
    options: CreationOptions,
): Promise<Result<unknown, PasskeyFailure>> {
    const made = await tryAsync(
        () =>
            navigator.credentials.create({
                publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(asJson(options)),
            }),
        failureOf,
    );
    if (!made.ok) return made;
    const credential = made.value;
    if (!(credential instanceof PublicKeyCredential)) return err("failed");
    return ok(credential.toJSON());
}
