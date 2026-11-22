import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { listReleaseFactSets, promoteFactSet } from "../../facts/promotion.ts";
import { asStaff, type WebRpcContext } from "./web-shared.ts";

export const factsHandlers = {
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
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
