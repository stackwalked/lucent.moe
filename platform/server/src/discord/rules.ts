import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, RoleId } from "@lucent/core/scalars";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
import { RuleFields, STAFF_FEEDS } from "@lucent/rpc/discord/rules";
import { z } from "zod";
import { lockAuthorized, readAsStaff } from "../authority/staff.ts";
import { appendAudit } from "../db/audit.ts";
import { type Db, type DbFailure, type Queryable, queryAll, queryOne, sql } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import type { RoleRule } from "./roles.rules.ts";

// The rules map site standing onto Discord roles, so changing them is managing roles.
const RULES_ACTION = "roles:manage";

export type StoredRule = {
    readonly id: string;
    readonly createdAt: EpochMs;
    readonly fields: RuleFields;
};

const RuleRowSchema = z.object({
    id: z.string(),
    kind: z.string(),
    discord_id: z.string(),
    condition: z.unknown(),
    feed: z.string().nullable(),
    created_at: EpochMs,
});

// Rows outlive the code that wrote them: one whose shape this build doesn't know does nothing.
function toStoredRule(row: z.output<typeof RuleRowSchema>): StoredRule | null {
    const fields = RuleFields.safeParse(
        row.kind === "role"
            ? { kind: "role", roleId: row.discord_id, condition: row.condition }
            : row.kind === "feed"
              ? { kind: "feed", channelId: row.discord_id, feed: row.feed }
              : { kind: row.kind, channelId: row.discord_id },
    );
    return fields.success ? { id: row.id, createdAt: row.created_at, fields: fields.data } : null;
}

export async function listRules(q: Queryable) {
    const rows = await queryAll(
        q,
        RuleRowSchema,
        sql`select id::text as id, kind, discord_id, condition, feed, created_at
            from connector_discord_rule order by created_at, id`,
    );
    if (!rows.ok) return rows;
    return ok(rows.value.map(toStoredRule).filter((rule) => rule !== null));
}

export function roleRulesOf(rules: readonly StoredRule[]): readonly RoleRule[] {
    return rules.flatMap(({ fields }) =>
        fields.kind === "role" ? [{ roleId: fields.roleId, condition: fields.condition }] : [],
    );
}

export function listRulesAsStaff(
    db: Db,
    params: { readonly caller: Caller; readonly catalog: ProductCatalog },
) {
    return readAsStaff(db, { caller: params.caller, actions: [RULES_ACTION] }, async (q) => {
        const rules = await listRules(q);
        if (!rules.ok) return rules;
        const roles = await queryAll(
            q,
            z.object({ id: RoleId, name: z.string() }),
            sql`select id, name from role order by rank desc, name`,
        );
        if (!roles.ok) return roles;
        return ok({
            rules: rules.value,
            products: [...params.catalog.values()].map(({ id, name }) => ({ id, name })),
            roles: roles.value,
        });
    });
}

function columnsOf(fields: RuleFields) {
    switch (fields.kind) {
        case "role":
            return { discordId: fields.roleId, condition: fields.condition, feed: null };
        case "staff_channel":
            return { discordId: fields.channelId, condition: null, feed: null };
        case "feed":
            return { discordId: fields.channelId, condition: null, feed: fields.feed };
    }
}

export async function addRule(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly catalog: ProductCatalog;
        readonly fields: RuleFields;
    },
): Promise<
    Result<
        { readonly ruleId: string },
        | { readonly code: "UNKNOWN_PRODUCT" }
        | { readonly code: "NOT_FOUND" }
        | { readonly code: "STAFF_CHANNEL_REQUIRED" }
        | AuthzRefusal
        | DbFailure
    >
> {
    const { fields } = params;
    if (
        fields.kind === "role" &&
        fields.condition.kind === "entitled" &&
        !params.catalog.has(fields.condition.productId)
    ) {
        return err({ code: "UNKNOWN_PRODUCT" as const });
    }
    const columns = columnsOf(fields);
    const condition = columns.condition === null ? null : JSON.stringify(columns.condition);
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: RULES_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        if (fields.kind === "role" && fields.condition.kind === "holds_role") {
            const role = await queryOne(
                tx,
                z.object({ id: z.string() }),
                sql`select id from role where id = ${fields.condition.roleId}`,
            );
            if (!role.ok) return role;
            if (role.value === null) return err({ code: "NOT_FOUND" as const });
        }
        // Anyone who can read the channel reads a queue post, so it goes only where staff are.
        if (fields.kind === "feed" && STAFF_FEEDS.has(fields.feed)) {
            const staff = await queryOne(
                tx,
                z.object({ id: z.string() }),
                sql`select id::text as id from connector_discord_rule
                    where kind = 'staff_channel' and discord_id = ${fields.channelId}`,
            );
            if (!staff.ok) return staff;
            if (staff.value === null) return err({ code: "STAFF_CHANNEL_REQUIRED" as const });
        }
        const inserted = await queryOne(
            tx,
            z.object({ id: z.string() }),
            sql`insert into connector_discord_rule (kind, discord_id, condition, feed, created_at)
                values (${fields.kind}, ${columns.discordId}, ${condition}::jsonb, ${columns.feed},
                        now())
                on conflict on constraint connector_discord_rule_once do nothing
                returning id::text as id`,
        );
        if (!inserted.ok) return inserted;
        if (inserted.value === null) {
            const existing = await queryOne(
                tx,
                z.object({ id: z.string() }),
                sql`select id::text as id from connector_discord_rule
                    where kind = ${fields.kind} and discord_id = ${columns.discordId}
                      and condition is not distinct from ${condition}::jsonb
                      and feed is not distinct from ${columns.feed}`,
            );
            if (!existing.ok) return existing;
            invariant(existing.value !== null, "a conflicting rule is there to find");
            return ok({ ruleId: existing.value.id });
        }
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "discord.rule_add",
            target: { ruleId: inserted.value.id, ...fields },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ ruleId: inserted.value.id });
    });
}

export async function removeRule(
    db: Db,
    params: { readonly caller: Caller; readonly ruleId: string },
) {
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: RULES_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const removed = await queryAll(
            tx,
            RuleRowSchema,
            sql`delete from connector_discord_rule where id = ${params.ruleId}::uuid
                returning id::text as id, kind, discord_id, condition, feed, created_at`,
        );
        if (!removed.ok) return removed;
        const [row] = removed.value;
        if (row === undefined) return err({ code: "NOT_FOUND" as const });
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "discord.rule_remove",
            target: { ruleId: row.id, ...toStoredRule(row)?.fields },
            at: txNow,
        });
    });
}
