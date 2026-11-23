import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { listReleaseOverrides, setOverride } from "../../facts/overrides.ts";
import { asStaff, type WebRpcContext } from "./web-shared.ts";

export const overridesHandlers = {
    "admin.overrides.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            listReleaseOverrides(ctx.auth.db, {
                caller,
                releaseId: Uint8Array.fromHex(input.releaseId),
            }),
        ),
    "admin.overrides.set": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            setOverride(ctx.auth.db, {
                caller,
                releaseId: Uint8Array.fromHex(input.releaseId),
                target: { kind: input.kind, key: BigInt(`0x${input.key}`) },
                off: input.off,
            }),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
