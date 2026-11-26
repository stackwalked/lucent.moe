import { ok, type Result } from "@lucent/core/result";
import { AccountId } from "@lucent/core/scalars";
import { Snowflake } from "@lucent/rpc/discord/rules";
import { z } from "zod";
import { type Db, type DbFailure, queryAll, queryOne, sql } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { decideRoles } from "./roles.rules.ts";
import { listRules, roleRulesOf } from "./rules.ts";

export type MemberRoles = { readonly userId: string; readonly roleIds: readonly string[] };

const StandingRowSchema = z.object({
    discord_user_id: z.string(),
    active: z.boolean(),
    products: z.array(z.string()),
    roles: z.array(z.string()),
});

// Standing as of the transaction: entitlements and role grants inside their windows now, the
// account neither suspended nor locked. One snapshot for the rules and every user.
export async function resolveMembers(
    db: Db,
    userIds: readonly string[],
): Promise<Result<{ readonly members: readonly MemberRoles[] }, DbFailure>> {
    return await withTx(db, async (tx) => {
        const rules = await listRules(tx);
        if (!rules.ok) return rules;
        const rows = await queryAll(
            tx,
            StandingRowSchema,
            sql`select l.discord_user_id,
                       a.status = 'active' and not a.is_locked as active,
                       array(select distinct ep.product_id
                             from entitlement e
                             join entitlement_product ep on ep.entitlement_id = e.id
                             where e.account_id = a.id and e.status = 'active'
                               and e.valid_from <= now()
                               and (e.valid_until is null or e.valid_until > now())) as products,
                       array(select ar.role_id from account_role ar
                             where ar.account_id = a.id
                               and (ar.expires_at is null or ar.expires_at > now())) as roles
                from connector_discord_link l
                join account a on a.id = l.account_id
                where l.discord_user_id = any(${[...userIds]}::text[])`,
        );
        if (!rows.ok) return rows;
        const roleRules = roleRulesOf(rules.value);
        const standings = new Map(rows.value.map((row) => [row.discord_user_id, row]));
        return ok({
            members: [...new Set(userIds)].map((userId) => {
                const row = standings.get(userId);
                const standing =
                    row === undefined
                        ? null
                        : {
                              active: row.active,
                              entitledProducts: new Set(row.products),
                              siteRoles: new Set(row.roles),
                          };
                return { userId, roleIds: decideRoles(roleRules, standing).value };
            }),
        });
    });
}

// Audit ids are taken when a row is inserted, not when it commits, so a writer that commits
// late can leave a row below a cursor already read past. Rows written in the last half minute
// below the cursor are read again (each tick, a few hundred ids back at most): writers commit
// well inside that, and the hourly reconcile covers anything that doesn't. Rereading only
// repeats a comparison.
const REREAD_ROWS = 500;
const REREAD_WINDOW = "30 seconds";
const ROWS_PER_READ = 1_000;

const AuditRowSchema = z.object({
    id: z.string(),
    operation: z.string(),
    target: z.record(z.string(), z.unknown()),
});

const RULE_OPERATIONS: ReadonlySet<string> = new Set(["discord.rule_add", "discord.rule_remove"]);

export async function readChanges(
    db: Db,
    after: string | null,
): Promise<
    Result<
        {
            readonly cursor: string;
            readonly userIds: readonly string[];
            readonly reconcile: boolean;
            readonly retiredRoleIds: readonly string[];
        },
        DbFailure
    >
> {
    return await withTx(db, async (tx) => {
        if (after === null) {
            const head = await queryOne(
                tx,
                z.object({ head: z.string() }),
                sql`select coalesce(max(id), 0)::text as head from audit`,
            );
            if (!head.ok) return head;
            return ok({
                cursor: head.value?.head ?? "0",
                userIds: [],
                reconcile: false,
                retiredRoleIds: [],
            });
        }
        const rows = await queryAll(
            tx,
            AuditRowSchema,
            sql`select id::text as id, operation, target from audit
                where id > ${after}::bigint - ${REREAD_ROWS}
                  and (id > ${after}::bigint or at > now() - ${REREAD_WINDOW}::interval)
                order by id
                limit ${ROWS_PER_READ}`,
        );
        if (!rows.ok) return rows;
        let cursor = BigInt(after);
        let reconcile = false;
        const accountIds = new Set<string>();
        const roleIds = new Set<string>();
        const userIds = new Set<string>();
        const retired = new Set<string>();
        for (const row of rows.value) {
            if (BigInt(row.id) > cursor) cursor = BigInt(row.id);
            if (RULE_OPERATIONS.has(row.operation)) reconcile = true;
            const account = AccountId.safeParse(row.target["accountId"]);
            if (account.success) accountIds.add(account.data);
            const user = Snowflake.safeParse(row.target["discordUserId"]);
            if (user.success) userIds.add(user.data);
            const role = z.string().safeParse(row.target["roleId"]);
            if (row.operation === "role.upsert" && role.success) roleIds.add(role.data);
            // A removed role rule names the Discord role it managed.
            const discordRole = Snowflake.safeParse(row.target["roleId"]);
            if (
                row.operation === "discord.rule_remove" &&
                row.target["kind"] === "role" &&
                discordRole.success
            ) {
                retired.add(discordRole.data);
            }
        }
        const linked = await queryAll(
            tx,
            z.object({ discord_user_id: z.string() }),
            sql`select l.discord_user_id from connector_discord_link l
                where l.account_id = any(${[...accountIds]}::text[])
                   or l.account_id in (select account_id from account_role
                                       where role_id = any(${[...roleIds]}::text[]))`,
        );
        if (!linked.ok) return linked;
        for (const row of linked.value) userIds.add(row.discord_user_id);
        return ok({
            cursor: cursor.toString(),
            userIds: [...userIds].sort(),
            reconcile,
            retiredRoleIds: [...retired].sort(),
        });
    });
}
