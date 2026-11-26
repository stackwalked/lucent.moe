import { invariant } from "@lucent/core/contain";
import { err, type Result } from "@lucent/core/result";
import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import {
    listAccounts,
    listRoles,
    readAccount,
    readRoleSummary,
} from "../../../identity/authority/reads.ts";
import { searchStaff } from "../../../identity/authority/search.ts";
import {
    assignAccountRole,
    createAccount,
    issueEntitlement,
    recoverAccount,
    reinstateAccount,
    renameAccount,
    suspendAccount,
    unassignAccountRole,
    upsertRole,
    type WriterFailure,
} from "../../../identity/authority/writers.ts";
import { asStaff, done, mapOk, type WebRpcContext } from "./web-shared.ts";

type ChannelRefusal = { readonly code: "UNKNOWN_PRODUCT" | "UNKNOWN_CHANNEL" };

function isNotChannelRefusal<E extends { readonly code: string }>(
    error: E,
): error is Exclude<E, ChannelRefusal> {
    return error.code !== "UNKNOWN_PRODUCT" && error.code !== "UNKNOWN_CHANNEL";
}

// The role editor never sends channel grants, so their refusals can't come back.
function withoutChannels<T, E extends { readonly code: string }>(
    result: Result<T, E>,
): Result<T, Exclude<E, ChannelRefusal>> {
    if (result.ok) return result;
    const error = result.error;
    invariant(
        isNotChannelRefusal(error),
        "a role saved without channel grants was refused for one",
    );
    return err(error);
}

// What issuing an entitlement can be refused with, given the contract's input: at least one product
// (so never NO_PRODUCTS), and none of the account or role writers' own codes.
type IssueRefusal = Extract<
    WriterFailure,
    {
        readonly code:
            | "FORBIDDEN"
            | "STEP_UP_REQUIRED"
            | "IDEMPOTENCY_CONFLICT"
            | "RECEIPT_UNREADABLE"
            | "NOT_FOUND"
            | "UNKNOWN_PRODUCT"
            | "PRODUCT_NOT_ISSUABLE"
            | "UNKNOWN_CHANNEL"
            | "INVALID_WINDOW"
            | "STATEMENT_TIMEOUT"
            | "SERIALIZATION_FAILURE"
            | "UNIQUE_VIOLATION"
            | "CHECK_VIOLATION"
            | "DB_UNAVAILABLE";
    }
>;

const ISSUE_CODES: ReadonlySet<string> = new Set<IssueRefusal["code"]>([
    "FORBIDDEN",
    "STEP_UP_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "RECEIPT_UNREADABLE",
    "NOT_FOUND",
    "UNKNOWN_PRODUCT",
    "PRODUCT_NOT_ISSUABLE",
    "UNKNOWN_CHANNEL",
    "INVALID_WINDOW",
    "STATEMENT_TIMEOUT",
    "SERIALIZATION_FAILURE",
    "UNIQUE_VIOLATION",
    "CHECK_VIOLATION",
    "DB_UNAVAILABLE",
]);

function isIssueRefusal(error: WriterFailure): error is IssueRefusal {
    return ISSUE_CODES.has(error.code);
}

function asIssued<T>(result: Result<T, WriterFailure>): Result<T, IssueRefusal> {
    if (result.ok) return result;
    const error = result.error;
    invariant(isIssueRefusal(error), `issuing an entitlement was refused with ${error.code}`);
    return err(error);
}

export const authorityHandlers = {
    "admin.search": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => searchStaff(ctx.auth.db, { caller, text: input.text })),
    "admin.accounts.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => listAccounts(ctx.auth.db, { caller, ...input })),
    "admin.accounts.get": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            readAccount(ctx.auth.db, { caller, accountId: input.accountId }),
        ),
    "admin.accounts.create": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(
                await createAccount({ db: ctx.auth.db, rng: ctx.auth.rng, caller, ...input }),
                (created) => ({
                    accountId: created.accountId,
                    setupToken: created.replayed ? null : created.setupToken,
                }),
            ),
        ),
    "admin.accounts.suspend": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(
                await suspendAccount({
                    db: ctx.auth.db,
                    caller,
                    operationId: input.operationId,
                    targetAccountId: input.accountId,
                    reason: input.reason,
                }),
                () => ({}),
            ),
        ),
    "admin.accounts.reinstate": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(
                await reinstateAccount({
                    db: ctx.auth.db,
                    caller,
                    operationId: input.operationId,
                    targetAccountId: input.accountId,
                }),
                () => ({}),
            ),
        ),
    "admin.accounts.rename": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(
                await renameAccount({
                    db: ctx.auth.db,
                    caller,
                    operationId: input.operationId,
                    targetAccountId: input.accountId,
                    username: input.username,
                }),
                (renamed) => ({ username: renamed.username }),
            ),
        ),
    "admin.accounts.recover": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            recoverAccount({
                db: ctx.auth.db,
                rng: ctx.auth.rng,
                caller,
                targetAccountId: input.accountId,
            }),
        ),

    "admin.entitlements.issue": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(
                asIssued(
                    await issueEntitlement({
                        db: ctx.auth.db,
                        rng: ctx.auth.rng,
                        catalog: ctx.catalog,
                        caller,
                        operationId: input.operationId,
                        targetAccountId: input.accountId,
                        validFrom: input.validFrom,
                        validUntil: input.validUntil,
                        products: input.products,
                    }),
                ),
                (issued) => ({ entitlementId: issued.entitlementId }),
            ),
        ),

    "admin.roles.list": (ctx, _input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(await listRoles(ctx.auth.db, { caller }), (roles) => ({ roles })),
        ),
    "admin.roles.get": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            readRoleSummary(ctx.auth.db, { caller, roleId: input.roleId }),
        ),
    "admin.roles.save": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            withoutChannels(
                mapOk(
                    await upsertRole({
                        db: ctx.auth.db,
                        catalog: ctx.catalog,
                        caller,
                        ...input,
                        channelGrants: "unchanged",
                    }),
                    (saved) => ({ roleId: saved.roleId }),
                ),
            ),
        ),
    "admin.roles.assign": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(
                await assignAccountRole({
                    db: ctx.auth.db,
                    caller,
                    targetAccountId: input.accountId,
                    roleId: input.roleId,
                    expiresAt: input.expiresAt,
                }),
            ),
        ),
    "admin.roles.unassign": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(
                await unassignAccountRole({
                    db: ctx.auth.db,
                    caller,
                    targetAccountId: input.accountId,
                    roleId: input.roleId,
                }),
            ),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
