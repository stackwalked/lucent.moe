import type { TransportRefusal } from "@lucent/rpc/contract";
import type { WebContract } from "@lucent/rpc/web";
import type { z } from "zod";

// One message per refusal code, for every code any procedure in the web contract can return:
// the type comes from the contract, so a code added there doesn't compile here until it has
// words. Forms override a message where their context changes what it means.

type CodeOf<E> = E extends { readonly code: infer C extends string } ? C : never;
type ContractCode = {
    [K in keyof WebContract]: CodeOf<z.output<WebContract[K]["error"]>>;
}[keyof WebContract];

export type RefusalCode = ContractCode | TransportRefusal["code"] | "THROTTLED";

// Failures with nothing to fix on the reader's side: they show the support reference.
export const UNEXPECTED: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
    "SERVICE_UNAVAILABLE",
    "AUTH_REQUIRED",
    "INVALID_REQUEST",
    "UNKNOWN_PROCEDURE",
    "PAYLOAD_TOO_LARGE",
]);

export const REFUSALS: Readonly<Record<RefusalCode, string>> = {
    SERVICE_UNAVAILABLE: "lucent.moe can't reach its server right now. try again in a moment.",
    AUTH_REQUIRED: "something went wrong on our side.",
    INVALID_REQUEST: "something went wrong on our side.",
    UNKNOWN_PROCEDURE: "something went wrong on our side.",
    PAYLOAD_TOO_LARGE: "that's more than we take in one go.",
    THROTTLED: "too many tries. wait a minute, then try again.",
    SESSION_INVALID: "you're signed out. sign in again.",
    REAUTH_REQUIRED: "confirm it's you first.",
    STEP_UP_REQUIRED: "confirm with your passkey first.",
    FORBIDDEN: "you can't do that.",
    NOT_FOUND: "that's gone.",
    FLOW_INVALID: "this timed out or had too many tries. start again.",
    PASSKEY_REJECTED: "that passkey isn't one we know. pick another, or use your password.",
    INVALID_CREDENTIALS: "username or password is wrong.",
    ACCOUNT_UNAVAILABLE: "this account is suspended.",
    NO_SECOND_FACTOR: "this account isn't fully set up. ask staff for a new setup link.",
    SETUP_INVALID: "this setup link has expired or was already used. ask staff for a new one.",
    INVALID_USERNAME: "3 to 24 characters: a–z, 0–9 and _, starting with a letter.",
    USERNAME_ALREADY_SET: "this account already has a username.",
    USERNAME_TAKEN: "that name is taken or too close to an existing one.",
    USERNAME_REQUIRED: "choose a username first.",
    PASSWORD_REJECTED: "use 12 to 128 characters.",
    LAST_CREDENTIAL: "that's your only way to sign in. add another first.",
    TOTP_ALREADY_ENROLLED: "an authenticator app is already set up. remove it first.",
    TOTP_NOT_PENDING: "start adding the authenticator app again.",
    TOTP_CODE_INVALID: "that code didn't work. codes change every 30 seconds.",
    NO_PASSKEY: "this needs a passkey. add one first.",
    EMAIL_TAKEN: "that email already has an account.",
    INVALID_RANK: "rank has to be below yours.",
    ROLE_NAME_TAKEN: "a role already has that name.",
    INVALID_CURSOR: "that page no longer exists. start from the first.",
    IDEMPOTENCY_CONFLICT: "this form changed since it was sent. reload and try again.",
};
// The text for one refusal, a form's own wording first where it has one.
export function refusalText(
    code: RefusalCode,
    overrides?: { readonly [C in RefusalCode]?: string },
): string {
    return overrides?.[code] ?? REFUSALS[code];
}
