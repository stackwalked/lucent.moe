import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { listUpdateDays } from "../../facts/updates.ts";
import { asStaff, mapOk, type WebRpcContext } from "./web-shared.ts";

export const updatesHandlers = {
    "admin.updates.list": (ctx, _input, call) =>
        asStaff(ctx, call, async (caller) =>
            mapOk(await listUpdateDays(ctx.auth.db, { caller }), (builds) => ({ builds })),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
