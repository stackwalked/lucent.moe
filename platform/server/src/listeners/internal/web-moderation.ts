import type { Handlers } from "@lucent/rpc/mount";
import type { moderationContract } from "@lucent/rpc/web/moderation";
import { createReport, listReports, resolveReport } from "../../moderation/reports.ts";
import {
    liftRestriction,
    listRestrictions,
    setRestriction,
} from "../../moderation/restrictions.ts";
import { asStaff, done, mapOk, served, type WebRpcContext } from "./web-shared.ts";

export const moderationHandlers = {
    "moderation.reports.create": async (ctx, input, { session }) =>
        served(done(await createReport(ctx.auth.db, session, { ...input, catalog: ctx.catalog }))),
    "admin.moderation.reports.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => listReports(ctx.auth.db, { caller, cursor: input.cursor })),
    "admin.moderation.reports.resolve": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) => {
            const resolved = await resolveReport({ db: ctx.auth.db, caller, ...input });
            // The record that a removal happened, written once it has committed.
            if (resolved.ok && resolved.value.removed !== null) {
                ctx.logger.write("info", "removed", {
                    origin: "internal-web",
                    detail: `${resolved.value.removed.kind} ${resolved.value.removed.id}`,
                });
            }
            return mapOk(resolved, () => ({}));
        }),
    "admin.moderation.restrictions.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            listRestrictions(ctx.auth.db, { caller, cursor: input.cursor }),
        ),
    "admin.moderation.restrictions.set": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            setRestriction({ db: ctx.auth.db, catalog: ctx.catalog, caller, ...input }),
        ),
    "admin.moderation.restrictions.lift": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(await liftRestriction({ db: ctx.auth.db, caller, id: input.id }), () => ({})),
        ),
} satisfies Handlers<WebRpcContext, typeof moderationContract>;
