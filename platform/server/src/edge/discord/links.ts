import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, type BearerToken, type ClientInfo, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import type { DiscordIdentity } from "../../base/adapters/discord/oauth.ts";
import { appendAudit } from "../../base/db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryOne,
    sql,
    type Tx,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { lockSession, readSession, type SessionInvalid } from "../../identity/auth/sessions.ts";
import { lockCallerWith } from "../../identity/authority/standing.ts";

const LinkRowSchema = z.object({ account_id: AccountId, discord_user_id: z.string() });

function findLinkOfAccount(q: Queryable, accountId: AccountId) {
    return queryOne(
        q,
        LinkRowSchema.extend({ linked_at: EpochMs }),
        sql`select account_id, discord_user_id, linked_at from connector_discord_link
            where account_id = ${accountId}`,
    );
}

function findLinkOfUser(q: Queryable, userId: string) {
    return queryOne(
        q,
        LinkRowSchema,
        sql`select account_id, discord_user_id from connector_discord_link
            where discord_user_id = ${userId}`,
    );
}

export async function readDiscordLink(
    db: Db,
    token: BearerToken,
): Promise<Result<{ readonly linkedAt: EpochMs | null }, SessionInvalid | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, { token, txNow, purposes: ["member"] });
        if (!session.ok) return session;
        const link = await findLinkOfAccount(tx, session.value.accountId);
        if (!link.ok) return link;
        return ok({ linkedAt: link.value?.linked_at ?? null });
    });
}

// The account locked as every writer locks it; null when there is none.
async function lockAccount(
    tx: Tx,
    accountId: AccountId,
    txNow: EpochMs,
): Promise<Result<{ readonly active: boolean } | null, DbFailure>> {
    const locked = await lockCallerWith(tx, {
        caller: { accountId, stepUpAt: null, client: null },
        targets: [],
        txNow,
    });
    if (locked.ok) return ok({ active: locked.value.subject.isActive });
    const failure = locked.error;
    if (failure.code === "FORBIDDEN" || failure.code === "STEP_UP_REQUIRED") return ok(null);
    return err(failure);
}

async function unlink(
    tx: Tx,
    params: {
        readonly accountId: AccountId;
        readonly userId: string;
        readonly txNow: EpochMs;
        readonly client: ClientInfo | null;
        readonly via: "site" | "discord";
    },
): Promise<Result<void, DbFailure>> {
    const removed = await execute(
        tx,
        sql`delete from connector_discord_link
            where account_id = ${params.accountId} and discord_user_id = ${params.userId}`,
    );
    if (!removed.ok) return removed;
    if (removed.value === 0) return ok(undefined);
    // The connector reads the Discord user from here: the link it named is gone.
    return await appendAudit(tx, {
        actorId: params.accountId,
        client: params.client,
        operation: "discord.unlink",
        target: { accountId: params.accountId, discordUserId: params.userId, via: params.via },
        at: params.txNow,
    });
}

export function removeDiscordLinkBySite(
    db: Db,
    params: { readonly token: BearerToken; readonly client: ClientInfo | null },
) {
    return withTx(db, async (tx, txNow) => {
        const member = await lockSession(tx, { token: params.token, txNow, purposes: ["member"] });
        if (!member.ok) return member;
        const { accountId } = member.value;
        const link = await findLinkOfAccount(tx, accountId);
        if (!link.ok) return link;
        if (link.value === null) return ok(undefined);
        return await unlink(tx, {
            accountId,
            userId: link.value.discord_user_id,
            txNow,
            client: params.client,
            via: "site",
        });
    });
}

// The identity comes from Discord's OAuth exchange, done before this transaction opens.
export function linkDiscordAccount(
    db: Db,
    params: {
        readonly token: BearerToken;
        readonly identity: DiscordIdentity;
        readonly client: ClientInfo | null;
    },
) {
    return withTx(db, async (tx, txNow) => {
        const member = await lockSession(tx, { token: params.token, txNow, purposes: ["member"] });
        if (!member.ok) return member;
        const { accountId } = member.value;
        const { userId, username } = params.identity;
        const accountLink = await findLinkOfAccount(tx, accountId);
        if (!accountLink.ok) return accountLink;
        const userLink = await findLinkOfUser(tx, userId);
        if (!userLink.ok) return userLink;
        if (accountLink.value !== null || userLink.value !== null) {
            return err({ code: "ALREADY_LINKED" as const });
        }
        // Another account's link to the same Discord user can commit between the read above and
        // here; the unique index makes this one wait for it and then insert nothing.
        const linked = await execute(
            tx,
            sql`insert into connector_discord_link (account_id, discord_user_id, linked_at, username)
                values (${accountId}, ${userId}, now(), ${username})
                on conflict do nothing`,
        );
        if (!linked.ok) return linked;
        if (linked.value === 0) return err({ code: "ALREADY_LINKED" as const });
        return await appendAudit(tx, {
            actorId: accountId,
            client: params.client,
            operation: "discord.link",
            target: { accountId, discordUserId: userId },
            at: txNow,
        });
    });
}
export async function removeDiscordLinkByUser(
    db: Db,
    params: { readonly userId: string },
): Promise<Result<{ readonly removed: boolean }, DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const link = await findLinkOfUser(tx, params.userId);
        if (!link.ok) return link;
        if (link.value === null) return ok({ removed: false });
        const accountId = link.value.account_id;
        const locked = await lockAccount(tx, accountId, txNow);
        if (!locked.ok) return locked;
        // Re-read under the lock: the site may have unlinked meanwhile.
        const still = await findLinkOfUser(tx, params.userId);
        if (!still.ok) return still;
        if (still.value?.account_id !== accountId) return ok({ removed: false });
        const removed = await unlink(tx, {
            accountId,
            userId: params.userId,
            txNow,
            client: null,
            via: "discord",
        });
        return removed.ok ? ok({ removed: true }) : removed;
    });
}
