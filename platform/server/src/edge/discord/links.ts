import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import { AccountId, type BearerToken, type ClientInfo, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryOne,
    sql,
    type Tx,
    toTimestamptz,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { lockSession, readSession, type SessionInvalid } from "../../identity/auth/sessions.ts";
import { lockCallerWith } from "../../identity/authority/standing.ts";
import { decideIssueCode, decideRedeem, type LinkRefusal } from "./links.rules.ts";

// Crockford's base32, as the device match codes: no I, L, O or U, and what a member types is
// folded back (I and L to 1, O to 0) before it is compared.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

function toLinkCode(bytes: Uint8Array): string {
    let bits = 0n;
    for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
    return code;
}

function foldLinkCode(typed: string): string {
    return typed
        .trim()
        .toUpperCase()
        .replace("-", "")
        .replaceAll("I", "1")
        .replaceAll("L", "1")
        .replaceAll("O", "0");
}

async function hashCode(code: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
}

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

export function startDiscordLink(
    db: Db,
    params: { readonly token: BearerToken; readonly rng: CryptoRng },
) {
    return withTx(db, async (tx, txNow) => {
        const member = await lockSession(tx, { token: params.token, txNow, purposes: ["member"] });
        if (!member.ok) return member;
        const { accountId } = member.value;
        const link = await findLinkOfAccount(tx, accountId);
        if (!link.ok) return link;
        const plan = decideIssueCode({ txNow, linked: link.value !== null });
        if (!plan.ok) return plan;
        const code = toLinkCode(params.rng.fillBytes(new Uint8Array(7)));
        const stored = await execute(
            tx,
            sql`insert into connector_discord_link_code (account_id, code_hash, expires_at, used_at)
                values (${accountId}, ${await hashCode(code)},
                        ${toTimestamptz(plan.value.expiresAt)}::timestamptz, null)
                on conflict (account_id) do update
                set code_hash = excluded.code_hash, expires_at = excluded.expires_at, used_at = null`,
        );
        if (!stored.ok) return stored;
        return ok({
            code: `${code.slice(0, 5)}-${code.slice(5)}`,
            expiresAt: plan.value.expiresAt,
        });
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

// The account is locked before its code is read again, so two redeems of one code serialize
// there and the second sees it used.
export async function redeemLinkCode(
    db: Db,
    params: { readonly userId: string; readonly code: string },
): Promise<Result<void, LinkRefusal | DbFailure>> {
    const codeHash = await hashCode(foldLinkCode(params.code));
    return await withTx(db, async (tx, txNow) => {
        const holder = await queryOne(
            tx,
            z.object({ account_id: AccountId }),
            sql`select account_id from connector_discord_link_code where code_hash = ${codeHash}`,
        );
        if (!holder.ok) return holder;
        if (holder.value === null) return err({ code: "CODE_INVALID" as const });
        const accountId = holder.value.account_id;
        const locked = await lockAccount(tx, accountId, txNow);
        if (!locked.ok) return locked;
        const code = await queryOne(
            tx,
            z.object({ expires_at: EpochMs, used_at: EpochMs.nullable() }),
            sql`select expires_at, used_at from connector_discord_link_code
                where account_id = ${accountId} and code_hash = ${codeHash}`,
        );
        if (!code.ok) return code;
        const accountLink = await findLinkOfAccount(tx, accountId);
        if (!accountLink.ok) return accountLink;
        const userLink = await findLinkOfUser(tx, params.userId);
        if (!userLink.ok) return userLink;
        const plan = decideRedeem({
            txNow,
            code:
                code.value === null
                    ? null
                    : { expiresAt: code.value.expires_at, usedAt: code.value.used_at },
            accountActive: locked.value?.active === true,
            accountLinked: accountLink.value !== null,
            userLinked: userLink.value !== null,
        });
        if (!plan.ok) return plan;
        const used = await execute(
            tx,
            sql`update connector_discord_link_code set used_at = now() where account_id = ${accountId}`,
        );
        if (!used.ok) return used;
        // Another account's redeem by the same Discord user can commit between the read above
        // and here; the unique index makes this one wait for it and then insert nothing.
        const linked = await execute(
            tx,
            sql`insert into connector_discord_link (account_id, discord_user_id, linked_at)
                values (${accountId}, ${params.userId}, now())
                on conflict do nothing`,
        );
        if (!linked.ok) return linked;
        if (linked.value === 0) return err({ code: "ALREADY_LINKED" as const });
        return await appendAudit(tx, {
            actorId: accountId,
            client: null,
            operation: "discord.link",
            target: { accountId, discordUserId: params.userId },
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
