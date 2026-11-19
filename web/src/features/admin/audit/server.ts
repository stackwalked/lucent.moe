import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { readPlatform } from "../../../server/platform.ts";
import { auditDetail, auditFilter } from "./filter.ts";

// 50 per page is platform's: the contract has no page size to ask for. The free-form detail
// is reduced here to what the table shows, so the raw record never reaches the browser.
export const listAudit = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z
            .strictObject({
                q: z.string().max(512).nullable(),
                cursor: z.string().max(512).nullable(),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.audit.list", {
            filter: auditFilter(data.q ?? undefined),
            cursor: data.cursor,
        });
        if (!reply.ok) return refuse(reply.error);
        return done({
            nextCursor: reply.value.nextCursor,
            items: reply.value.items.map((entry) => ({
                id: entry.id,
                at: entry.at,
                actor: entry.actor,
                operation: entry.operation,
                target: { accountId: entry.target.accountId, username: entry.target.username },
                detail: auditDetail(entry.operation, entry.target.detail),
            })),
        });
    });
