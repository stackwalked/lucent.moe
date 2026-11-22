import { AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { AuditEntry, Cursor, pageOf, ReadRefusal } from "./shared.ts";

export const auditContract = defineContract({
    "admin.audit.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({
            filter: z.strictObject({
                actorId: z.string().max(64).nullable(),
                targetAccountId: AccountId.nullable(),
                operation: z.string().max(64).nullable(),
                before: EpochMs.nullable(),
            }),
            cursor: Cursor.nullable(),
        }),
        output: pageOf(AuditEntry),
        error: ReadRefusal,
    },
});
