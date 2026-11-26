import { invariant, tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { AccountId } from "@lucent/core/scalars";
import { toBase64Url } from "@lucent/core/scalars";
import {
    type AuthenticationResponse,
    CreationOptions,
    type RegistrationResponse,
    RequestOptions,
} from "@lucent/rpc/webauthn";
import {
    type AuthenticationResponseJSON,
    generateAuthenticationOptions,
    generateRegistrationOptions,
    type RegistrationResponseJSON,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { z } from "zod";

// Who the passkeys are for: `rpId` is the registrable domain they bind to, `origin` the web
// origin browsers report signing from. Both come from config; nothing a client sends sets them.
export type RelyingParty = {
    readonly rpId: string;
    readonly rpName: string;
    readonly origin: string;
};

export type StoredPasskey = {
    readonly id: Uint8Array;
    readonly publicKey: Uint8Array;
    readonly signCount: number;
    readonly transports: readonly string[];
};

export type PasskeyRefusal = { readonly code: "PASSKEY_REJECTED" };

const rejected: PasskeyRefusal = { code: "PASSKEY_REJECTED" };

// The library's options pass through our wire schemas here, so a change in what it emits stops at
// this line instead of reaching browsers.
function asWire<T>(schema: z.ZodType<T>, options: unknown, what: string): T {
    const parsed = schema.safeParse(options);
    invariant(parsed.success, `@simplewebauthn/server emitted ${what} our schema refuses`);
    return parsed.data;
}

// The user handle is the account id: discoverable passkeys hand it back, and it names no one
// outside lucent.
export async function registrationOptions(params: {
    readonly rp: RelyingParty;
    readonly challenge: Uint8Array;
    readonly accountId: AccountId;
    readonly username: string;
    readonly existing: readonly StoredPasskey[];
}): Promise<CreationOptions> {
    const options = await generateRegistrationOptions({
        rpName: params.rp.rpName,
        rpID: params.rp.rpId,
        userName: params.username,
        userID: new TextEncoder().encode(params.accountId),
        challenge: Uint8Array.from(params.challenge),
        attestationType: "none",
        excludeCredentials: params.existing.map((passkey) => ({
            id: toBase64Url(passkey.id),
            transports: [...passkey.transports],
        })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return asWire(CreationOptions, options, "creation options");
}

export type RegisteredPasskey = {
    readonly id: Uint8Array;
    readonly publicKey: Uint8Array;
    readonly signCount: number;
    readonly transports: readonly string[];
    readonly backedUp: boolean;
};

export async function verifyRegistration(params: {
    readonly rp: RelyingParty;
    readonly challenge: Uint8Array;
    readonly response: RegistrationResponse;
}): Promise<Result<RegisteredPasskey, PasskeyRefusal>> {
    const verified = await tryAsync(
        () =>
            verifyRegistrationResponse({
                response: toRegistrationJSON(params.response),
                expectedChallenge: toBase64Url(params.challenge),
                expectedOrigin: params.rp.origin,
                expectedRPID: params.rp.rpId,
                requireUserVerification: true,
            }),
        () => rejected,
    );
    if (!verified.ok) return verified;
    if (!verified.value.verified) return err(rejected);
    const info = verified.value.registrationInfo;
    return ok({
        id: Uint8Array.fromBase64(info.credential.id, { alphabet: "base64url" }),
        publicKey: Uint8Array.from(info.credential.publicKey),
        signCount: info.credential.counter,
        transports: params.response.response.transports ?? [],
        backedUp: info.credentialBackedUp,
    });
}

export async function authenticationOptions(params: {
    readonly rp: RelyingParty;
    readonly challenge: Uint8Array;
    readonly allow: readonly StoredPasskey[];
}): Promise<RequestOptions> {
    const options = await generateAuthenticationOptions({
        rpID: params.rp.rpId,
        challenge: Uint8Array.from(params.challenge),
        userVerification: "required",
        allowCredentials: params.allow.map((passkey) => ({
            id: toBase64Url(passkey.id),
            transports: [...passkey.transports],
        })),
    });
    return asWire(RequestOptions, options, "request options");
}

export function rawIdOf(response: { readonly rawId: string }): Uint8Array {
    return Uint8Array.fromBase64(response.rawId, { alphabet: "base64url" });
}

// Returns the counter to store. Many authenticators always report 0; only a non-zero counter that
// fails to grow says the credential was cloned.
export async function verifyAssertion(params: {
    readonly rp: RelyingParty;
    readonly challenge: Uint8Array;
    readonly response: AuthenticationResponse;
    readonly passkey: StoredPasskey;
}): Promise<Result<{ readonly signCount: number }, PasskeyRefusal>> {
    const verified = await tryAsync(
        () =>
            verifyAuthenticationResponse({
                response: toAuthenticationJSON(params.response),
                expectedChallenge: toBase64Url(params.challenge),
                expectedOrigin: params.rp.origin,
                expectedRPID: params.rp.rpId,
                requireUserVerification: true,
                credential: {
                    id: toBase64Url(params.passkey.id),
                    publicKey: Uint8Array.from(params.passkey.publicKey),
                    counter: params.passkey.signCount,
                    transports: [...params.passkey.transports],
                },
            }),
        () => rejected,
    );
    if (!verified.ok) return verified;
    if (!verified.value.verified) return err(rejected);
    return ok({ signCount: verified.value.authenticationInfo.newCounter });
}

// Zod reports an absent optional field as `undefined`; the library's types (under
// exactOptionalPropertyTypes) want it missing. Verification reads only the attestation object and
// client data; the browser's convenience copies of what they contain stay behind.
function toRegistrationJSON(parsed: RegistrationResponse): RegistrationResponseJSON {
    const { clientDataJSON, attestationObject, transports } = parsed.response;
    const response = { clientDataJSON, attestationObject };
    return {
        id: parsed.id,
        rawId: parsed.rawId,
        type: parsed.type,
        clientExtensionResults: parsed.clientExtensionResults,
        response: transports === undefined ? response : { ...response, transports },
    };
}

function toAuthenticationJSON(parsed: AuthenticationResponse): AuthenticationResponseJSON {
    const { userHandle, ...response } = parsed.response;
    return {
        id: parsed.id,
        rawId: parsed.rawId,
        type: parsed.type,
        clientExtensionResults: parsed.clientExtensionResults,
        response: userHandle === undefined ? response : { ...response, userHandle },
    };
}
