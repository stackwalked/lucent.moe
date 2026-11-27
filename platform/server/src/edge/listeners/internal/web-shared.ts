import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import type { AccountId, BearerToken, ClientInfo } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import type { Logger } from "../../../base/core/log.ts";
import type { DbFailure } from "../../../base/db/pool.ts";
import type { CloudLimits } from "../../../delivery/cloud/items.rules.ts";
import type { OverrideSigner } from "../../../delivery/runtime/lease-key.ts";
import type { AuthDeps } from "../../../identity/auth/deps.ts";
import type { SessionInvalid } from "../../../identity/auth/sessions.ts";
import { resolveCaller } from "../../../identity/auth/viewer.ts";

export type WebRpcContext = {
    readonly cloudLimits?: CloudLimits;
    readonly catalog: ProductCatalog;
    readonly auth: AuthDeps;
    // For lines a handler writes once its transaction has committed (a moderator's removal).
    readonly logger: Logger;
    // Where ARTIFACT_DIR is: resource bytes are kept there and the system page measures it; null
    // or left out without the loaders' listener.
    readonly artifactDir?: string | null;
    // Signs the override document a kill switch changes; null or left out without the loaders'
    // listener, which nothing then serves.
    readonly overrideSigner?: OverrideSigner | null;
    // Live presence from the event hub; absent in tests, where nobody is present.
    readonly presentOnline?: (accountId: AccountId) => boolean;
    // Tells the hub the roster's inputs changed (a block, last seen, visibility); absent in tests.
    readonly rosterChanged?: () => void;
};

type Unavailable = { readonly code: "SERVICE_UNAVAILABLE" };

// Failures that are the server's, not the request's: a receipt that won't parse is a bug here.
type Unservable = DbFailure | { readonly code: "RECEIPT_UNREADABLE" };

const UNSERVABLE_CODES: ReadonlySet<string> = new Set([
    "STATEMENT_TIMEOUT",
    "SERIALIZATION_FAILURE",
    "UNIQUE_VIOLATION",
    "CHECK_VIOLATION",
    "DB_UNAVAILABLE",
    "RECEIPT_UNREADABLE",
]);

function isServable<E extends { readonly code: string }>(
    error: E,
): error is Exclude<E, Unservable> {
    return !UNSERVABLE_CODES.has(error.code);
}

// A database failure is the server being unavailable, as far as web is concerned; the detail
// stays out of the reply.
export function served<T, E extends { readonly code: string }>(
    result: Result<T, E>,
): Result<T, Exclude<E, Unservable> | Unavailable> {
    if (result.ok) return result;
    if (isServable(result.error)) return err(result.error);
    return err({ code: "SERVICE_UNAVAILABLE" });
}

export function done<E>(result: Result<void, E>): Result<Record<string, never>, E> {
    return result.ok ? ok({}) : result;
}

// An admin procedure acts as the account holding the member session.
export async function asStaff<T, E extends { readonly code: string }>(
    ctx: WebRpcContext,
    call: { readonly session: BearerToken; readonly client: ClientInfo | null },
    act: (caller: Caller) => Promise<Result<T, E>>,
): Promise<Result<T, Exclude<E | SessionInvalid | DbFailure, Unservable> | Unavailable>> {
    const caller = await resolveCaller(ctx.auth.db, {
        sessionToken: call.session,
        client: call.client,
        stepUpWaived: ctx.auth.passwordOnly === true,
    });
    if (!caller.ok) return served(caller);
    return served(await act(caller.value));
}

export function mapOk<T, U, E>(result: Result<T, E>, map: (value: T) => U): Result<U, E> {
    return result.ok ? ok(map(result.value)) : result;
}
