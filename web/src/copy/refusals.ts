import type { TransportRefusal } from "@lucent/rpc/contract";
import type { WebContract } from "@lucent/rpc/web";
import type { AvatarUploadRefusal } from "@lucent/rpc/web/profile";
import type { z } from "zod";
import { RULES_COPY } from "./rules.ts";
import { SHARED_COPY } from "./shared.ts";

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
    INVALID_BASE: "this item changed. reload its history.",
    ITEM_LIMIT: "item limit reached",
    VERSION_LIMIT: "version limit reached",
    SIZE_LIMIT: "this version is too large.",
    STORAGE_LIMIT: "storage full",
    SHARE_LIMIT: "this item can't hold more links. revoke one first.",
    SERVICE_UNAVAILABLE: "can't reach the server. try again shortly.",
    AUTH_REQUIRED: "something went wrong on our side.",
    INVALID_REQUEST: "something went wrong on our side.",
    UNKNOWN_PROCEDURE: "something went wrong on our side.",
    PAYLOAD_TOO_LARGE: "too much in one go",
    THROTTLED: "too many tries. wait a minute.",
    SESSION_INVALID: "signed out. sign in again.",
    REAUTH_REQUIRED: "confirm it's you first.",
    STEP_UP_REQUIRED: "confirm with your passkey first.",
    FORBIDDEN: "not allowed",
    NOT_FOUND: SHARED_COPY.notFound,
    FLOW_INVALID: "timed out or too many tries. start again.",
    PASSKEY_REJECTED: "unknown passkey. use another, or your password.",
    INVALID_CREDENTIALS: "username or password is wrong.",
    ACCOUNT_UNAVAILABLE: SHARED_COPY.suspended,
    NO_SECOND_FACTOR: "account not fully set up. ask staff for a setup link.",
    SETUP_INVALID: SHARED_COPY.setupLinkGone,
    RESET_INVALID: "reset link no longer works. request a new one.",
    INVALID_USERNAME: RULES_COPY.username,
    USERNAME_ALREADY_SET: "username already set",
    USERNAME_TAKEN: "username taken or too close to another",
    USERNAME_REQUIRED: "choose a username first.",
    PASSWORD_REJECTED: RULES_COPY.password,
    PASSWORD_BREACHED: "password found in a data breach",
    LAST_CREDENTIAL: "this is your only way to sign in. add another first.",
    TOTP_ALREADY_ENROLLED: "authenticator app already set up",
    TOTP_NOT_PENDING: "start adding the app again.",
    TOTP_CODE_INVALID: SHARED_COPY.wrongCode,
    NO_PASSKEY: SHARED_COPY.needsPasskey,
    EMAIL_TAKEN: "email already has an account.",
    INVALID_RANK: "rank must be below yours.",
    ROLE_NAME_TAKEN: "role name taken",
    INVALID_CURSOR: "page gone. start from the first.",
    IDEMPOTENCY_CONFLICT: "form changed since it was sent. reload.",
    DEVICE_CHANGE_TOO_SOON: "pc changed in the last 7 days",
    UNKNOWN_PRODUCT: "product no longer in the catalog",
    PRODUCT_NOT_ISSUABLE: "product can't be granted.",
    UNKNOWN_CHANNEL: "product has no such channel.",
    INVALID_WINDOW: "end must come after start.",
    SEAL_BELOW_CURRENT: "a higher seal is current. re-sign the old release to go back.",
    REVISION_BELOW_CURRENT: "a newer revision is current.",
    POSTING_RESTRICTED: "posting restricted",
    LIMIT_REACHED: "posting limit reached. try later.",
    UNKNOWN_TARGET: "release has no such feature or capability.",
    ALREADY_DECIDED: "already closed by someone else",
    TICKET_CLOSED: "ticket closed",
    TICKET_FULL: "ticket full. open a new one.",
    TICKET_LIMIT: "too many open tickets",
    ALREADY_LINKED: "discord already linked",
    STAFF_CHANNEL_REQUIRED: "queues need a staff channel. mark it staff first.",
    PROFILE_REMOVED: "profile removed by staff. write a new bio first.",
    IMAGE_TOO_LARGE: "picture too large: 512 kb and 4096 pixels a side at most",
    NOT_AN_IMAGE: "not a jpeg, png or webp",
    IMAGE_UNDECODABLE: "picture can't be read.",
    IMAGE_TIMED_OUT: "picture took too long to read.",
    NO_ALLOWANCE: "no invites left",
    INVITE_USED: "invite already used",
    INVITE_INVALID: "invite expired, used or revoked",
    MAIL_DISABLED: "email isn't set up, so this can't be sent.",
    BELOW_SPENT: "can't go below the invites already used.",
    PRODUCT_NOT_OFFERED: "product not open to applications",
};
// The text for one refusal, a form's own wording first where it has one.
export function refusalText(
    code: RefusalCode,
    overrides?: { readonly [C in RefusalCode]?: string },
): string {
    return overrides?.[code] ?? REFUSALS[code];
}
