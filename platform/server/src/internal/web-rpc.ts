import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { BearerToken, ClientInfo } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { type Handlers, implement } from "@lucent/rpc/mount";
import { type WebContract, webContract } from "@lucent/rpc/web";
import {
    beginPasskeyRegistration,
    beginStepUp,
    beginTotpEnrollment,
    confirmTotpEnrollment,
    finishPasskeyRegistration,
    finishStepUp,
    listCredentials,
    removeCredential,
    setPassword,
} from "../auth/credentials.ts";
import type { AuthDeps } from "../auth/deps.ts";
import type { SessionInvalid } from "../auth/sessions.ts";
import { listSessions, signOut, signOutOthers, signOutSession } from "../auth/sessions.ts";
import { chooseUsername, redeemSetupLink } from "../auth/setup.ts";
import {
    beginPasskeySignIn,
    finishPasskeySignIn,
    signInWithPassword,
    signInWithTotp,
} from "../auth/sign-in.ts";
import { resolveCaller, resolveViewer } from "../auth/viewer.ts";
import {
    listAccounts,
    listAudit,
    listRoles,
    readAccount,
    readRoleSummary,
} from "../authority/reads.ts";
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
} from "../authority/writers.ts";
import type { DbFailure } from "../db/pool.ts";
import {
    approveEnrollment,
    denyEnrollment,
    listDevices,
    listPendingEnrollments,
    removeDevice,
    renameDevice,
} from "../native/devices.ts";
import { decideSignInRequest, readSignInRequest, SignInRequestId } from "../native/sign-in.ts";
import { readLoaderOffer } from "./download.ts";
import { listReleaseFactSets, promoteFactSet } from "./fact-sets.ts";
import { listMemberProducts } from "./products.ts";
import { listReleaseLines, promoteRelease } from "./releases.ts";

export type WebRpcContext = {
    readonly catalog: ProductCatalog;
    readonly auth: AuthDeps;
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
function served<T, E extends { readonly code: string }>(
    result: Result<T, E>,
): Result<T, Exclude<E, Unservable> | Unavailable> {
    if (result.ok) return result;
    if (isServable(result.error)) return err(result.error);
    return err({ code: "SERVICE_UNAVAILABLE" });
}

function done<E>(result: Result<void, E>): Result<Record<string, never>, E> {
    return result.ok ? ok({}) : result;
}

// Domain functions take the client as an optional field, absent when unknown.
function from(call: { readonly client: ClientInfo | null }): { readonly client?: ClientInfo } {
    return call.client === null ? {} : { client: call.client };
}

// An admin procedure acts as the account holding the member session.
async function asStaff<T, E extends { readonly code: string }>(
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

function mapOk<T, U, E>(result: Result<T, E>, map: (value: T) => U): Result<U, E> {
    return result.ok ? ok(map(result.value)) : result;
}

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

const handlers: Handlers<WebRpcContext, WebContract> = {
    "health.check": (ctx) => Promise.resolve(ok({ productsLoaded: ctx.catalog.size })),
    "catalog.list": (ctx) => Promise.resolve(ok([...ctx.catalog.values()])),

    "signIn.password": async (ctx, input, call) =>
        served(await signInWithPassword(ctx.auth, { ...input, ...from(call) })),
    "signIn.totp": async (ctx, input, call) =>
        served(await signInWithTotp(ctx.auth, { ...input, ...from(call) })),
    "signIn.passkey.begin": async (ctx, input) => served(await beginPasskeySignIn(ctx.auth, input)),
    "signIn.passkey.finish": async (ctx, input, call) =>
        served(await finishPasskeySignIn(ctx.auth, { ...input, ...from(call) })),

    "session.resolve": async (ctx, _input, { session, client }) =>
        served(
            await resolveViewer(ctx.auth.db, {
                sessionToken: session,
                client,
                stepUpWaived: ctx.auth.passwordOnly === true,
            }),
        ),
    "session.list": async (ctx, _input, { session }) => {
        const listed = await listSessions(ctx.auth.db, { sessionToken: session });
        return served(listed.ok ? ok({ sessions: listed.value }) : listed);
    },
    "session.end": async (ctx, input, { session }) =>
        served(
            done(
                input.sessionId === null
                    ? await signOut(ctx.auth.db, { sessionToken: session })
                    : await signOutSession(ctx.auth.db, {
                          sessionToken: session,
                          sessionId: input.sessionId,
                      }),
            ),
        ),
    "session.endOthers": async (ctx, _input, { session }) =>
        served(done(await signOutOthers(ctx.auth.db, { sessionToken: session }))),

    "setup.redeem": async (ctx, input, call) =>
        served(await redeemSetupLink(ctx.auth, { ...input, ...from(call) })),
    "setup.username.choose": async (ctx, input, call) =>
        served(
            await chooseUsername(ctx.auth, {
                sessionToken: call.session,
                username: input.username,
                ...from(call),
            }),
        ),

    "credentials.list": async (ctx, _input, { session }) =>
        served(await listCredentials(ctx.auth, { sessionToken: session })),
    "credentials.password.set": async (ctx, input, call) =>
        served(
            done(
                await setPassword(ctx.auth, {
                    sessionToken: call.session,
                    password: input.password,
                    ...from(call),
                }),
            ),
        ),
    "credentials.totp.enroll": async (ctx, _input, { session }) =>
        served(await beginTotpEnrollment(ctx.auth, { sessionToken: session })),
    "credentials.totp.confirm": async (ctx, input, call) =>
        served(
            done(
                await confirmTotpEnrollment(ctx.auth, {
                    sessionToken: call.session,
                    code: input.code,
                    ...from(call),
                }),
            ),
        ),
    "credentials.passkey.register.begin": async (ctx, _input, { session }) =>
        served(await beginPasskeyRegistration(ctx.auth, { sessionToken: session })),
    "credentials.passkey.register.finish": async (ctx, input, call) =>
        served(
            await finishPasskeyRegistration(ctx.auth, {
                sessionToken: call.session,
                ...input,
                ...from(call),
            }),
        ),
    "credentials.remove": async (ctx, input, call) => {
        const credential = input.credential;
        const removed = await removeCredential(ctx.auth, {
            sessionToken: call.session,
            credential:
                credential.kind === "passkey"
                    ? {
                          kind: "passkey",
                          id: Uint8Array.fromBase64(credential.id, { alphabet: "base64url" }),
                      }
                    : credential,
            ...from(call),
        });
        return served(done(removed));
    },

    "stepUp.begin": async (ctx, _input, { session }) =>
        served(await beginStepUp(ctx.auth, { sessionToken: session })),
    "stepUp.finish": async (ctx, input, { session }) =>
        served(await finishStepUp(ctx.auth, { sessionToken: session, ...input })),

    "devices.signIn.read": async (ctx, input, { session }) =>
        served(
            await readSignInRequest(ctx.auth.db, {
                sessionToken: session,
                requestId: SignInRequestId.parse(input.requestId),
            }),
        ),
    "devices.signIn.approve": async (ctx, input, { session }) =>
        served(
            await decideSignInRequest(ctx.auth.db, {
                rng: ctx.auth.rng,
                sessionToken: session,
                requestId: SignInRequestId.parse(input.requestId),
                decision: "approve",
            }),
        ),
    "devices.signIn.deny": async (ctx, input, { session }) =>
        served(
            await decideSignInRequest(ctx.auth.db, {
                rng: ctx.auth.rng,
                sessionToken: session,
                requestId: SignInRequestId.parse(input.requestId),
                decision: "deny",
            }),
        ),
    "devices.enrollments.list": async (ctx, _input, { session }) =>
        served(
            mapOk(
                await listPendingEnrollments(ctx.auth.db, { sessionToken: session }),
                (enrollments) => ({
                    enrollments,
                }),
            ),
        ),
    "devices.enrollments.approve": async (ctx, input, { session }) =>
        served(
            await approveEnrollment(ctx.auth.db, {
                rng: ctx.auth.rng,
                sessionToken: session,
                operationId: input.operationId,
                enrollmentId: Uint8Array.fromHex(input.enrollmentId),
            }),
        ),
    "devices.enrollments.deny": async (ctx, input, { session }) =>
        served(
            done(
                await denyEnrollment(ctx.auth.db, {
                    sessionToken: session,
                    enrollmentId: Uint8Array.fromHex(input.enrollmentId),
                }),
            ),
        ),
    "devices.list": async (ctx, _input, { session }) =>
        served(await listDevices(ctx.auth.db, { sessionToken: session })),
    "devices.rename": async (ctx, input, { session }) =>
        served(
            done(
                await renameDevice(ctx.auth.db, {
                    sessionToken: session,
                    deviceId: Uint8Array.fromHex(input.deviceId),
                    name: input.name,
                }),
            ),
        ),
    "devices.remove": async (ctx, input, { session }) =>
        served(
            done(
                await removeDevice(ctx.auth.db, {
                    sessionToken: session,
                    operationId: input.operationId,
                    deviceId: Uint8Array.fromHex(input.deviceId),
                }),
            ),
        ),

    "products.list": async (ctx, _input, { session }) =>
        served(
            mapOk(
                await listMemberProducts(ctx.auth.db, {
                    catalog: ctx.catalog,
                    sessionToken: session,
                }),
                (products) => ({ products }),
            ),
        ),

    "download.loader": async (ctx, _input, { session }) =>
        served(
            mapOk(
                await readLoaderOffer(ctx.auth.db, { catalog: ctx.catalog, sessionToken: session }),
                (offer) =>
                    offer.state === "ready" ? { state: offer.state, number: offer.number } : offer,
            ),
        ),

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

    "admin.releases.list": (ctx, _input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(
                await listReleaseLines(ctx.auth.db, { catalog: ctx.catalog, caller }),
                (lines) => ({
                    lines,
                }),
            ),
        ),
    "admin.releases.promote": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            promoteRelease(ctx.auth.db, { catalog: ctx.catalog, caller, ...input }),
        ),
    "admin.facts.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            listReleaseFactSets(ctx.auth.db, {
                caller,
                releaseId: Uint8Array.fromHex(input.releaseId),
            }),
        ),
    "admin.facts.promote": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            promoteFactSet(ctx.auth.db, {
                caller,
                releaseId: Uint8Array.fromHex(input.releaseId),
                setId: input.setId,
            }),
        ),

    "admin.audit.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => listAudit(ctx.auth.db, { caller, ...input })),
};

export const webProcedures = implement(webContract, handlers);
