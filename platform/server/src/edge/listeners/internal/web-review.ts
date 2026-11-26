import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { decideReviewItem, listReviewItems } from "../../../delivery/risk/review.ts";
import { asStaff, done, type WebRpcContext } from "./web-shared.ts";

export const reviewHandlers = {
    "admin.review.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            listReviewItems(ctx.auth.db, { caller, state: input.state }),
        ),
    "admin.review.decide": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(
                await decideReviewItem(ctx.auth.db, {
                    caller,
                    itemId: input.itemId,
                    outcome: input.outcome,
                    note: input.note === null || input.note === "" ? null : input.note,
                }),
            ),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
