import {
    type AuthenticationResponseJSON,
    generateAuthenticationOptions,
    generateRegistrationOptions,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { z } from "zod";
import { tryAsync } from "../core/contain.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { AccountId } from "../core/scalars.ts";
import { toBase64Url } from "../core/scalars.ts";

// Who the passkeys are for: `rpId` is the registrable domain they bind to, `origin` the web
// origin browsers report signing from. Both come from config; nothing a client sends sets them.
export type RelyingParty = {
    readonly rpId: string;
    readonly rpName: string;
    readonly origin: string;
};

const Base64UrlString = z
    .string()
    .regex(/^[A-Za-z0-9_-]*$/)
    .refine((value) => value.length % 4 !== 1, "not base64url")
    .max(16_384);

const ClientExtensionResults = z.object({});

export const RegistrationResponse = z.strictObject({
    id: Base64UrlString,
    rawId: Base64UrlString,
    type: z.literal("public-key"),
    authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
    clientExtensionResults: ClientExtensionResults,
    response: z.object({
        clientDataJSON: Base64UrlString,
        attestationObject: Base64UrlString,
        transports: z.array(z.string().max(32)).max(8).optional(),
    }),
});

export const AuthenticationResponse = z.strictObject({
    id: Base64UrlString,
    rawId: Base64UrlString,
    type: z.literal("public-key"),
    authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
    clientExtensionResults: ClientExtensionResults,
    response: z.object({
        clientDataJSON: Base64UrlString,
        authenticatorData: Base64UrlString,
        signature: Base64UrlString,
        userHandle: Base64UrlString.optional(),
    }),
});

export type StoredPasskey = {
    readonly id: Uint8Array;
    readonly publicKey: Uint8Array;
    readonly signCount: number;
    readonly transports: readonly string[];
};

export type PasskeyRefusal = { readonly code: "PASSKEY_REJECTED" };

const rejected: PasskeyRefusal = { code: "PASSKEY_REJECTED" };

// The user handle is the account id: discoverable passkeys hand it back, and it names no one
// outside lucent.
export function registrationOptions(params: {
    readonly rp: RelyingParty;
    readonly challenge: Uint8Array;
    readonly accountId: AccountId;
    readonly username: string;
    readonly existing: readonly StoredPasskey[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
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
    readonly response: z.output<typeof RegistrationResponse>;
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

export function authenticationOptions(params: {
    readonly rp: RelyingParty;
    readonly challenge: Uint8Array;
    readonly allow: readonly StoredPasskey[];
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
        rpID: params.rp.rpId,
        challenge: Uint8Array.from(params.challenge),
        userVerification: "required",
        allowCredentials: params.allow.map((passkey) => ({
            id: toBase64Url(passkey.id),
            transports: [...passkey.transports],
        })),
    });
}

export function rawIdOf(response: { readonly rawId: string }): Uint8Array {
    return Uint8Array.fromBase64(response.rawId, { alphabet: "base64url" });
}

// Returns the counter to store. Many authenticators always report 0; only a non-zero counter that
// fails to grow says the credential was cloned.
export async function verifyAssertion(params: {
    readonly rp: RelyingParty;
    readonly challenge: Uint8Array;
    readonly response: z.output<typeof AuthenticationResponse>;
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
// exactOptionalPropertyTypes) want it missing.
function toRegistrationJSON(
    parsed: z.output<typeof RegistrationResponse>,
): RegistrationResponseJSON {
    const { transports, ...response } = parsed.response;
    return {
        id: parsed.id,
        rawId: parsed.rawId,
        type: parsed.type,
        clientExtensionResults: parsed.clientExtensionResults,
        response: transports === undefined ? response : { ...response, transports },
    };
}

function toAuthenticationJSON(
    parsed: z.output<typeof AuthenticationResponse>,
): AuthenticationResponseJSON {
    const { userHandle, ...response } = parsed.response;
    return {
        id: parsed.id,
        rawId: parsed.rawId,
        type: parsed.type,
        clientExtensionResults: parsed.clientExtensionResults,
        response: userHandle === undefined ? response : { ...response, userHandle },
    };
}
