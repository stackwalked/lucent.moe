import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { listReleaseLines, promoteRelease } from "../../../delivery/releases/promotion.ts";
import { asStaff, mapOk, type WebRpcContext } from "./web-shared.ts";

export const releasesHandlers = {
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
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
