import { invariant } from "@lucent/core/contain";
import { ok, type Result } from "@lucent/core/result";
import { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import { revokeAccess } from "../auth/revoke-access.ts";
import { parseUsername, type UsernameInvalid } from "../authority/usernames.ts";
import { appendAudit } from "../db/audit.ts";
import { type Db, type DbFailure, execute, queryAll, sql } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import {
    decideRootTransfer,
    type RootTransferPlan,
    type RootTransferRefusal,
} from "./root-transfer.rules.ts";

const ACTOR = "cli:transfer-superadmin";

const PartyRow = z.object({
    id: AccountId,
    username: z.string().nullable(),
    status: z.enum(["active", "suspended"]),
    is_locked: z.boolean(),
    is_root: z.boolean(),
    has_passkey: z.boolean(),
});

function toParty(row: z.output<typeof PartyRow> | undefined) {
    return row === undefined
        ? null
        : { id: row.id, status: row.status, isLocked: row.is_locked, hasPasskey: row.has_passkey };
}

// Root to the account holding `username`, from whoever holds it now. Run from ops: database
// access stands in for the old root's consent, which no caller can give (nothing targets root).
// The old root keeps its account and credentials, as a member with no roles who can sign in
// again, but its sessions and other ongoing access end in the same transaction (revokeAccess):
// a transfer may be made precisely because the old root is compromised.
//
// Both rows are locked in id order. A transfer racing this one changes the root row under the
// lock, so the loser no longer finds a root and refuses with NO_ROOT; rerunning it is safe.
export async function transferRoot(params: {
    readonly db: Db;
    readonly username: string;
}): Promise<Result<RootTransferPlan, RootTransferRefusal | UsernameInvalid | DbFailure>> {
    const parsed = parseUsername(params.username);
    if (!parsed.ok) return parsed;
    const { username } = parsed.value;

    return await withTx(params.db, async (tx, txNow) => {
        const rows = await queryAll(
            tx,
            PartyRow,
            sql`select id, username, status, is_locked, is_root,
                       exists (select 1 from passkey where account_id = account.id) as has_passkey
                from account
                where is_root or username = ${username}
                order by id for update`,
        );
        if (!rows.ok) return rows;
        const plan = decideRootTransfer({
            root: toParty(rows.value.find((row) => row.is_root)),
            target: toParty(rows.value.find((row) => row.username === username)),
        });
        if (!plan.ok) return plan;
        const { from, to } = plan.value;

        // migrations/0022_root_transfer.sql: these two rows, this transaction only. Cleared again before
        // anything else runs in it.
        const relaxed = await execute(
            tx,
            sql`select set_config('lucent.root_transfer', ${`${from} ${to}`}, true)`,
        );
        if (!relaxed.ok) return relaxed;
        // The old root first: account_single_root_idx is checked per statement.
        const demoted = await execute(
            tx,
            sql`update account set is_root = false where id = ${from} and is_root`,
        );
        if (!demoted.ok) return demoted;
        const promoted = await execute(
            tx,
            sql`update account set is_root = true where id = ${to} and not is_root`,
        );
        if (!promoted.ok) return promoted;
        invariant(demoted.value === 1 && promoted.value === 1, "root rows change only under lock");
        const restored = await execute(
            tx,
            sql`select set_config('lucent.root_transfer', '', true)`,
        );
        if (!restored.ok) return restored;

        const revoked = await revokeAccess(tx, from);
        if (!revoked.ok) return revoked;

        const audited = await appendAudit(tx, {
            actorId: ACTOR,
            client: null,
            operation: "account.transfer_root",
            target: { accountId: to, fromAccountId: from },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok(plan.value);
    });
}
