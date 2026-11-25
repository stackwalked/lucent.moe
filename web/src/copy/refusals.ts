import type { TransportRefusal } from "@lucent/rpc/contract";
import type { WebContract } from "@lucent/rpc/web";
import type { AvatarUploadRefusal } from "@lucent/rpc/web/profile";
import type { z } from "zod";
import { RULES_COPY } from "./rules.ts";

// One message per refusal code, for every code any procedure in the web contract can return:
// the type comes from the contract, so a code added there doesn't compile here until it has
// words. Forms override a message where their context changes what it means.

type CodeOf<E> = E extends { readonly code: infer C extends string } ? C : never;
type ContractCode = {
    [K in keyof WebContract]: CodeOf<z.output<WebContract[K]["error"]>>;
}[keyof WebContract];

// The avatar upload is a streamed route, not a procedure, so its refusals are named apart.
type AvatarUploadCode = z.output<typeof AvatarUploadRefusal>["code"];

export type RefusalCode = ContractCode | AvatarUploadCode | TransportRefusal["code"] | "THROTTLED";

// Failures with nothing to fix on the reader's side: they show the support reference.
export const UNEXPECTED: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
    "SERVICE_UNAVAILABLE",
    "AUTH_REQUIRED",
    "INVALID_REQUEST",
    "UNKNOWN_PROCEDURE",
    "PAYLOAD_TOO_LARGE",
]);

export const REFUSALS: Readonly<Record<RefusalCode, string>> = {
    INVALID_BASE: "reload the item's history and try again.",
    ITEM_LIMIT: "remove an item to make room.",
    VERSION_LIMIT: "this item has reached its version limit.",
    SIZE_LIMIT: "this version is too large.",
    STORAGE_LIMIT: "remove an item to free storage.",
    SHARE_LIMIT: "this item has as many links as it can hold. revoke one first.",
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
    RESET_INVALID: "this reset link no longer works. request a new one.",
    INVALID_USERNAME: RULES_COPY.username,
    USERNAME_ALREADY_SET: "this account already has a username.",
    USERNAME_TAKEN: "that name is taken or too close to an existing one.",
    USERNAME_REQUIRED: "choose a username first.",
    PASSWORD_REJECTED: RULES_COPY.password,
    PASSWORD_BREACHED: "that password is in a known data breach. choose another.",
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
    DEVICE_CHANGE_TOO_SOON: "you changed a pc in the last 7 days. wait until the window opens.",
    UNKNOWN_PRODUCT: "that product isn't in the catalog anymore. reload and try again.",
    PRODUCT_NOT_ISSUABLE: "you can't grant access to this product. choose another product.",
    UNKNOWN_CHANNEL: "that channel isn't one this product has. reload and try again.",
    INVALID_WINDOW: "the end has to come after the start.",
    SEAL_BELOW_CURRENT: "a higher seal is current. sign the old release anew to go back.",
    REVISION_BELOW_CURRENT: "a newer revision is current. publish the fix as the next one.",
    POSTING_RESTRICTED: "you can't post here right now.",
    LIMIT_REACHED: "you've reached the limit for that. try again later.",
    UNKNOWN_TARGET: "this release doesn't have that feature or capability. reload and try again.",
    ALREADY_DECIDED: "someone already closed this item. reload to see the outcome.",
    TICKET_CLOSED: "this ticket was closed. reload to see it.",
    TICKET_FULL: "this ticket is full. open a new one.",
    TICKET_LIMIT: "you have too many open tickets. close one first.",
    ALREADY_LINKED: "this account is already linked to discord. unlink it first.",
    STAFF_CHANNEL_REQUIRED: "queues go only to a staff channel. mark the channel staff first.",
    PROFILE_REMOVED: "staff removed your profile. write a new bio first.",
    IMAGE_TOO_LARGE: "that picture is too large. use one under 512 kb and 4096 pixels a side.",
    NOT_AN_IMAGE: "that isn't a picture we take. use a jpeg, png or webp.",
    IMAGE_UNDECODABLE: "that picture couldn't be read. try another.",
    IMAGE_TIMED_OUT: "that picture took too long to read. try a smaller one.",
    NO_ALLOWANCE: "you have no invites left. staff decide how many you get.",
    INVITE_USED: "this invite was already used.",
    INVITE_INVALID:
        "this invite has expired, was used or was revoked. ask whoever sent it for a new one.",
    MAIL_DISABLED: "invites can't be redeemed right now. try again later.",
    BELOW_SPENT: "that's fewer than this account has already used.",
    PRODUCT_NOT_OFFERED: "that product isn't open to applications. reload and choose again.",
};
// The text for one refusal, a form's own wording first where it has one.
export function refusalText(
    code: RefusalCode,
    overrides?: { readonly [C in RefusalCode]?: string },
): string {
    return overrides?.[code] ?? REFUSALS[code];
}
