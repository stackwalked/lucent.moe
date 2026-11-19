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
    SERVICE_UNAVAILABLE: "lucent.moe can't reach its server right now. Try again in a moment.",
    AUTH_REQUIRED: "Something went wrong on our side.",
    INVALID_REQUEST: "Something went wrong on our side.",
    UNKNOWN_PROCEDURE: "Something went wrong on our side.",
    PAYLOAD_TOO_LARGE: "That's more than we take in one go.",
    THROTTLED: "Too many tries. Wait a minute, then try again.",
    SESSION_INVALID: "You're signed out. Sign in again.",
    REAUTH_REQUIRED: "Confirm it's you first.",
    STEP_UP_REQUIRED: "Confirm with your passkey first.",
    FORBIDDEN: "You can't do that.",
    NOT_FOUND: "That's gone.",
    FLOW_INVALID: "This timed out or had too many tries. Start again.",
    PASSKEY_REJECTED: "That passkey isn't one we know. Pick another, or use your password.",
    INVALID_CREDENTIALS: "Username or password is wrong.",
    ACCOUNT_UNAVAILABLE: "This account is suspended.",
    NO_SECOND_FACTOR: "This account isn't fully set up. Ask staff for a new setup link.",
    SETUP_INVALID: "This setup link has expired or was already used. Ask staff for a new one.",
    INVALID_USERNAME: "3 to 24 characters: a–z, 0–9 and _, starting with a letter.",
    USERNAME_ALREADY_SET: "This account already has a username.",
    USERNAME_TAKEN: "That name is taken or too close to an existing one.",
    USERNAME_REQUIRED: "Choose a username first.",
    PASSWORD_REJECTED: "Use 12 to 128 characters.",
    LAST_CREDENTIAL: "That's your only way to sign in. Add another first.",
    TOTP_ALREADY_ENROLLED: "An authenticator app is already set up. Remove it first.",
    TOTP_NOT_PENDING: "Start adding the authenticator app again.",
    TOTP_CODE_INVALID: "That code didn't work. Codes change every 30 seconds.",
    NO_PASSKEY: "This needs a passkey. Add one first.",
    EMAIL_TAKEN: "That email already has an account.",
    INVALID_RANK: "Rank has to be below yours.",
    ROLE_NAME_TAKEN: "A role already has that name.",
    INVALID_CURSOR: "That page no longer exists. Start from the first.",
    IDEMPOTENCY_CONFLICT: "This form changed since it was sent. Reload and try again.",
};
// The text for one refusal, a form's own wording first where it has one.
export function refusalText(
    code: RefusalCode,
    overrides?: { readonly [C in RefusalCode]?: string },
): string {
    return overrides?.[code] ?? REFUSALS[code];
}
