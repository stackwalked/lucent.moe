import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import {
    approveApplication,
    declineApplication,
    listApplications,
    listOfferedProducts,
    readApplication,
    submitApplication,
} from "../../../identity/admission/applications.ts";
import {
    createInvite,
    type GrantRefusal,
    listOwnInvites,
    readInviteStanding,
    readInviteTree,
    redeemInvite,
    revokeInvite,
    setInviteAllowance,
} from "../../../identity/admission/invites.ts";
import { asStaff, done, served, type WebRpcContext } from "./web-shared.ts";

// The contract bounds the allowance to what the rule accepts, so INVALID_ALLOWANCE can't come back.
function withinBounds<T>(
    result: Result<T, GrantRefusal>,
): Result<T, Exclude<GrantRefusal, { readonly code: "INVALID_ALLOWANCE" }>> {
    if (result.ok) return result;
    const error = result.error;
    invariant(error.code !== "INVALID_ALLOWANCE", "the contract bounds an allowance");
    return err(error);
}

export const admissionHandlers = {
    "invites.mine.list": async (ctx, _input, { session }) =>
        served(await listOwnInvites(ctx.auth.db, session)),
    "invites.mine.create": async (ctx, _input, { session }) =>
        served(await createInvite(ctx.auth, session)),
    "invites.mine.revoke": async (ctx, input, { session }) =>
        served(done(await revokeInvite(ctx.auth.db, session, input.inviteId))),
    "invites.link.redeem": async (ctx, input, call) =>
        served(done(await redeemInvite(ctx.auth, { ...input, client: call.client }))),
    "admin.invites.account": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            readInviteStanding(ctx.auth.db, { caller, accountId: input.accountId }),
        ),
    "admin.invites.tree": (ctx, _input, call) =>
        asStaff(ctx, call, (caller) => readInviteTree(ctx.auth.db, { caller })),
    "admin.invites.grant": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(withinBounds(await setInviteAllowance(ctx.auth.db, { caller, ...input }))),
        ),

    "waitlist.products.list": async (ctx) => ok(listOfferedProducts(ctx.catalog)),
    "waitlist.application.submit": async (ctx, input) =>
        served(done(await submitApplication(ctx.auth, { catalog: ctx.catalog, input }))),
    "admin.applications.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            listApplications(ctx.auth.db, { caller, state: input.state }),
        ),
    "admin.applications.get": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            readApplication(ctx.auth.db, { caller, applicationId: input.applicationId }),
        ),
    "admin.applications.approve": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            approveApplication(ctx.auth, { caller, applicationId: input.applicationId }),
        ),
    "admin.applications.decline": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(
                await declineApplication(ctx.auth.db, {
                    caller,
                    applicationId: input.applicationId,
                }),
            ),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
