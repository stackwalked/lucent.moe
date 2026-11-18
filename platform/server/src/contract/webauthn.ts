import { z } from "zod";

// The WebAuthn Level 3 JSON shapes (https://www.w3.org/TR/webauthn-3/), as browsers'
// `toJSON()` and `PublicKeyCredential.parse*OptionsFromJSON` exchange them. Our own, so the
// contract carries no server library's types; the server parses the library's options through
// these before replying, so a change in its output shows up on our side of the wire.

const Base64Url = z
    .string()
    .regex(/^[A-Za-z0-9_-]*$/)
    .refine((value) => value.length % 4 !== 1, "not base64url")
    .max(16_384);

// Browsers drop transports and hints they don't know, so these stay open strings.
const Transports = z.array(z.string().max(32)).max(8);
const Hints = z.array(z.enum(["security-key", "client-device", "hybrid"])).max(3);
const Requirement = z.enum(["discouraged", "preferred", "required"]);
const Attachment = z.enum(["platform", "cross-platform"]);

const CredentialDescriptor = z.object({
    type: z.literal("public-key"),
    id: Base64Url,
    transports: Transports.optional(),
});

export const CreationOptions = z.object({
    rp: z.object({ id: z.string().max(253).optional(), name: z.string().max(64) }),
    user: z.object({
        id: Base64Url,
        name: z.string().max(64),
        displayName: z.string().max(64),
    }),
    challenge: Base64Url,
    pubKeyCredParams: z
        .array(z.object({ type: z.literal("public-key"), alg: z.number().int() }))
        .max(16),
    timeout: z.number().int().nonnegative().optional(),
    excludeCredentials: z.array(CredentialDescriptor).max(64).optional(),
    authenticatorSelection: z
        .object({
            authenticatorAttachment: Attachment.optional(),
            residentKey: Requirement.optional(),
            requireResidentKey: z.boolean().optional(),
            userVerification: Requirement.optional(),
        })
        .optional(),
    hints: Hints.optional(),
    attestation: z.enum(["none", "indirect", "direct", "enterprise"]).optional(),
    extensions: z.object({ credProps: z.boolean().optional() }).optional(),
});
export type CreationOptions = z.output<typeof CreationOptions>;

export const RequestOptions = z.object({
    challenge: Base64Url,
    timeout: z.number().int().nonnegative().optional(),
    rpId: z.string().max(253).optional(),
    allowCredentials: z.array(CredentialDescriptor).max(64).optional(),
    userVerification: Requirement.optional(),
    hints: Hints.optional(),
});
export type RequestOptions = z.output<typeof RequestOptions>;

// We read no extension outputs, so whatever a browser reports there is dropped.
const ClientExtensionResults = z.object({});

export const RegistrationResponse = z.strictObject({
    id: Base64Url,
    rawId: Base64Url,
    type: z.literal("public-key"),
    authenticatorAttachment: Attachment.optional(),
    clientExtensionResults: ClientExtensionResults,
    response: z.strictObject({
        clientDataJSON: Base64Url,
        attestationObject: Base64Url,
        authenticatorData: Base64Url.optional(),
        transports: Transports.optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: Base64Url.optional(),
    }),
});
export type RegistrationResponse = z.output<typeof RegistrationResponse>;

export const AuthenticationResponse = z.strictObject({
    id: Base64Url,
    rawId: Base64Url,
    type: z.literal("public-key"),
    authenticatorAttachment: Attachment.optional(),
    clientExtensionResults: ClientExtensionResults,
    response: z.strictObject({
        clientDataJSON: Base64Url,
        authenticatorData: Base64Url,
        signature: Base64Url,
        userHandle: Base64Url.optional(),
    }),
});
export type AuthenticationResponse = z.output<typeof AuthenticationResponse>;
