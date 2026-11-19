import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import {
    AccountId,
    type BearerToken,
    EpochMs,
    type OperationId,
    toHex,
} from "@lucent/core/scalars";
import type { EnrollmentStatus, KeyStorage } from "@lucent/wire/enrollment";
import { z } from "zod";
import {
    lockSession,
    readSession,
    requireFresh,
    type SessionInvalid,
    type SessionRefusal,
} from "../auth/sessions.ts";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryAll,
    queryOne,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { type ReceiptRefusal, readReplay, recordReceipt, toOperationKey } from "../db/receipt.ts";
import { withTx } from "../db/tx.ts";
import { type AccountInactive, lockActiveAccount } from "./accounts.ts";
import type { DpopProof } from "./dpop.ts";
import { matchCodeOf, newWireId } from "./ids.ts";
import type { TokenHolder } from "./sign-in.ts";

// A device is a PC's key bound to an account. A member enrolls a PC from its loader (proven by the
// candidate key) and confirms it in the browser, matching the code both show. An account holds
// one live device by default; a member replaces it themselves at most once in seven days.

export const MAX_DEVICES = 1;
const ENROLLMENT_TTL_MS = 10 * 60 * 1_000;
export const SELF_SERVICE_REPLACEMENT_MS = 7 * 24 * 60 * 60 * 1_000;

const Bytes = z.instanceof(Uint8Array);
const Storage = z.enum(["tpm", "software"]);

export type DeviceRow = {
    readonly id: Uint8Array;
    readonly jkt: string;
    readonly revokedAt: EpochMs | null;
};

const DeviceRowSchema = z.object({ id: Bytes, jkt: z.string(), revoked_at: EpochMs.nullable() });

// The account's device with this key, live or not; the newest when the key came back after a
// revocation.
export async function findDeviceByKey(
    q: Queryable,
    params: { readonly accountId: AccountId; readonly jkt: string },
): Promise<Result<DeviceRow | null, DbFailure>> {
    const row = await queryOne(
        q,
        DeviceRowSchema,
        sql`select id, jkt, revoked_at from device
            where account_id = ${params.accountId} and jkt = ${params.jkt}
            order by revoked_at is null desc, enrolled_at desc limit 1`,
    );
    if (!row.ok) return row;
    return ok(
        row.value === null
            ? null
            : { id: row.value.id, jkt: row.value.jkt, revokedAt: row.value.revoked_at },
    );
}

// Locks a device row, second in the canonical lock order (after the account).
export async function lockDevice(
    tx: Tx,
    deviceId: Uint8Array,
): Promise<Result<DeviceRow, DbFailure>> {
    const row = await queryOne(
        tx,
        DeviceRowSchema,
        sql`select id, jkt, revoked_at from device where id = ${deviceId} for update`,
    );
    if (!row.ok) return row;
    invariant(row.value !== null, "a device a start or session names exists");
    return ok({ id: row.value.id, jkt: row.value.jkt, revokedAt: row.value.revoked_at });
}

async function lockLiveDevices(
    tx: Tx,
    accountId: AccountId,
): Promise<Result<readonly Uint8Array[], DbFailure>> {
    const rows = await queryAll(
        tx,
        z.object({ id: Bytes }),
        sql`select id from device where account_id = ${accountId} and revoked_at is null
            order by id for update`,
    );
    if (!rows.ok) return rows;
    return ok(rows.value.map((row) => row.id));
}

async function mayReplaceItself(
    q: Queryable,
    accountId: AccountId,
    txNow: EpochMs,
): Promise<Result<boolean, DbFailure>> {
    const row = await queryOne(
        q,
        z.object({ last_replaced_at: EpochMs }),
        sql`select last_replaced_at from device_change_window where account_id = ${accountId}`,
    );
    if (!row.ok) return row;
    return ok(
        row.value === null || row.value.last_replaced_at + SELF_SERVICE_REPLACEMENT_MS <= txNow,
    );
}

async function startChangeWindow(
    tx: Tx,
    accountId: AccountId,
    txNow: EpochMs,
): Promise<Result<number, DbFailure>> {
    return await execute(
        tx,
        sql`insert into device_change_window (account_id, last_replaced_at)
            values (${accountId}, ${toTimestamptz(txNow)}::timestamptz)
            on conflict (account_id) do update set last_replaced_at = excluded.last_replaced_at`,
    );
}

async function liveKeyOwner(
    q: Queryable,
    jkt: string,
): Promise<Result<AccountId | null, DbFailure>> {
    const row = await queryOne(
        q,
        z.object({ account_id: AccountId }),
        sql`select account_id from device where jkt = ${jkt} and revoked_at is null`,
    );
    if (!row.ok) return row;
    return ok(row.value?.account_id ?? null);
}

const EnrollmentRowSchema = z.object({
    id: Bytes,
    account_id: z.string(),
    jkt: z.string(),
    public_key: z.unknown(),
    storage: Storage,
    created_at: EpochMs,
    expires_at: EpochMs,
    state: z.enum(["pending", "approved", "denied", "expired"]),
    device_id: Bytes.nullable(),
});
type EnrollmentRow = z.output<typeof EnrollmentRowSchema>;

function statusOf(row: EnrollmentRow, txNow: EpochMs): EnrollmentStatus {
    if (row.state === "approved") {
        invariant(row.device_id !== null, "an approved enrollment names its device");
        return { enrollment: row.id, state: "approved", device: row.device_id };
    }
    if (row.state === "pending" && row.expires_at <= txNow) {
        return { enrollment: row.id, state: "expired" };
    }
    return { enrollment: row.id, state: row.state };
}

const ENROLLMENT_COLUMNS = sql`id, account_id, jkt, public_key, storage, created_at, expires_at, state, device_id`;

export type EnrollmentRefusal =
    | AccountInactive
    | ReceiptRefusal
    | { readonly code: "ALREADY_ENROLLED" | "KEY_IN_USE" | "ENROLLMENT_LIMIT" };

const EnrollmentReceipt = z.object({ enrollment: z.string().regex(/^[0-9a-f]{32}$/) });

// POST /v1/enrollments: the candidate key asks to become this account's device. A key already
// pending gets its pending enrollment back, so a loader that lost the reply just polls it.
export async function requestEnrollment(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly holder: TokenHolder;
        readonly proof: DpopProof;
        readonly storage: KeyStorage;
        readonly operationId: OperationId;
    },
): Promise<Result<EnrollmentStatus, EnrollmentRefusal | DbFailure>> {
    const { accountId } = params.holder;
    const { jkt } = params.proof;
    const op = await toOperationKey({
        principal: `account:${accountId}`,
        endpoint: "v1.enrollments",
        operationId: params.operationId,
        payload: { jkt, storage: params.storage },
    });
    const newId = newWireId(params.rng);

    return await withTx(db, async (tx, txNow) => {
        const account = await lockActiveAccount(tx, accountId, txNow);
        if (!account.ok) return account;
        const live = await lockLiveDevices(tx, accountId);
        if (!live.ok) return live;

        const replay = await readReplay(tx, op, EnrollmentReceipt);
        if (!replay.ok) return replay;
        if (replay.value.replayed) {
            const row = await queryOne(
                tx,
                EnrollmentRowSchema,
                sql`select ${ENROLLMENT_COLUMNS} from device_enrollment
                    where id = ${Uint8Array.fromHex(replay.value.result.enrollment)}`,
            );
            if (!row.ok) return row;
            invariant(row.value !== null, "a receipt's enrollment exists");
            return ok(statusOf(row.value, txNow));
        }

        const owner = await liveKeyOwner(tx, jkt);
        if (!owner.ok) return owner;
        if (owner.value === accountId) return err({ code: "ALREADY_ENROLLED" });
        if (owner.value !== null) return err({ code: "KEY_IN_USE" });
        if (live.value.length >= MAX_DEVICES) {
            const replaceable = await mayReplaceItself(tx, accountId, txNow);
            if (!replaceable.ok) return replaceable;
            if (!replaceable.value) return err({ code: "ENROLLMENT_LIMIT" });
        }

        const pending = await queryOne(
            tx,
            EnrollmentRowSchema,
            sql`select ${ENROLLMENT_COLUMNS} from device_enrollment
                where account_id = ${accountId} and jkt = ${jkt} and state = 'pending'
                for update`,
        );
        if (!pending.ok) return pending;
        let row = pending.value;
        if (row !== null && row.expires_at <= txNow) {
            const expired = await execute(
                tx,
                sql`update device_enrollment set state = 'expired' where id = ${row.id}`,
            );
            if (!expired.ok) return expired;
            row = null;
        }
        if (row === null) {
            const inserted = await queryOne(
                tx,
                EnrollmentRowSchema,
                sql`insert into device_enrollment
                        (id, account_id, jkt, public_key, storage, created_at, expires_at)
                    values (${newId}, ${accountId}, ${jkt}, ${JSON.stringify(params.proof.key)}::jsonb,
                            ${params.storage}, ${toTimestamptz(txNow)}::timestamptz,
                            ${toTimestamptz(EpochMs.parse(txNow + ENROLLMENT_TTL_MS))}::timestamptz)
                    returning ${ENROLLMENT_COLUMNS}`,
            );
            if (!inserted.ok) return inserted;
            invariant(inserted.value !== null, "insert returning yields its row");
            row = inserted.value;
        }
        const recorded = await recordReceipt(tx, op, { enrollment: toHex(row.id) });
        if (!recorded.ok) return recorded;
        return ok(statusOf(row, txNow));
    });
}

// The loader's poll: only the key that asked may read its enrollment.
export async function readEnrollment(
    db: Db,
    params: {
        readonly holder: TokenHolder;
        readonly proof: DpopProof;
        readonly enrollmentId: Uint8Array;
    },
): Promise<Result<EnrollmentStatus, { readonly code: "NOT_FOUND" } | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const row = await queryOne(
            tx,
            EnrollmentRowSchema,
            sql`select ${ENROLLMENT_COLUMNS} from device_enrollment
                where id = ${params.enrollmentId}
                  and account_id = ${params.holder.accountId} and jkt = ${params.proof.jkt}`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err({ code: "NOT_FOUND" });
        return ok(statusOf(row.value, txNow));
    });
}

export type PendingEnrollment = {
    readonly enrollmentId: string;
    readonly matchCode: string;
    readonly storage: KeyStorage;
    readonly createdAt: EpochMs;
    readonly expiresAt: EpochMs;
};

// What web lists for the member to confirm, newest first.
export async function listPendingEnrollments(
    db: Db,
    params: { readonly sessionToken: BearerToken },
): Promise<Result<readonly PendingEnrollment[], SessionInvalid | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const rows = await queryAll(
            tx,
            EnrollmentRowSchema,
            sql`select ${ENROLLMENT_COLUMNS} from device_enrollment
                where account_id = ${session.value.accountId} and state = 'pending'
                  and expires_at > ${toTimestamptz(txNow)}::timestamptz
                order by created_at desc, id`,
        );
        if (!rows.ok) return rows;
        return ok(
            rows.value.map((row) => ({
                enrollmentId: toHex(row.id),
                matchCode: matchCodeOf(row.jkt),
                storage: row.storage,
                createdAt: row.created_at,
                expiresAt: row.expires_at,
            })),
        );
    });
}

type NotFound = { readonly code: "NOT_FOUND" };
type Forbidden = { readonly code: "FORBIDDEN" };

export type Approved = { readonly deviceId: string; readonly replaced: boolean };

const ApprovedReceipt = z.object({
    deviceId: z.string().regex(/^[0-9a-f]{32}$/),
    replaced: z.boolean(),
});

async function lockPendingEnrollment(
    tx: Tx,
    params: {
        readonly accountId: AccountId;
        readonly enrollmentId: Uint8Array;
        readonly txNow: EpochMs;
    },
): Promise<Result<EnrollmentRow, NotFound | DbFailure>> {
    const row = await queryOne(
        tx,
        EnrollmentRowSchema,
        sql`select ${ENROLLMENT_COLUMNS} from device_enrollment
            where id = ${params.enrollmentId} and account_id = ${params.accountId}
            for update`,
    );
    if (!row.ok) return row;
    if (
        row.value === null ||
        row.value.state !== "pending" ||
        row.value.expires_at <= params.txNow
    ) {
        return err({ code: "NOT_FOUND" });
    }
    return ok(row.value);
}

// The member confirms a pending enrollment in the browser, having proven a factor in the last few
// minutes: a session cookie alone can't bind a PC. At the limit, the new device replaces the live
// one when the self-service window allows; FORBIDDEN covers the rare races (the window closed or
// the key was enrolled elsewhere since the loader asked), which the loader's own request already
// refused with a reason otherwise.
export async function approveEnrollment(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly sessionToken: BearerToken;
        readonly operationId: OperationId;
        readonly enrollmentId: Uint8Array;
    },
): Promise<Result<Approved, SessionRefusal | NotFound | Forbidden | ReceiptRefusal | DbFailure>> {
    const deviceId = newWireId(params.rng);
    return await withTx(db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const fresh = requireFresh(session.value, txNow);
        if (!fresh.ok) return fresh;
        const { accountId } = session.value;
        const op = await toOperationKey({
            principal: `account:${accountId}`,
            endpoint: "devices.enrollments.approve",
            operationId: params.operationId,
            payload: { enrollmentId: toHex(params.enrollmentId) },
        });
        const live = await lockLiveDevices(tx, accountId);
        if (!live.ok) return live;

        const replay = await readReplay(tx, op, ApprovedReceipt);
        if (!replay.ok) return replay;
        if (replay.value.replayed) return ok(replay.value.result);

        const enrollment = await lockPendingEnrollment(tx, {
            accountId,
            enrollmentId: params.enrollmentId,
            txNow,
        });
        if (!enrollment.ok) return enrollment;
        const owner = await liveKeyOwner(tx, enrollment.value.jkt);
        if (!owner.ok) return owner;
        if (owner.value !== null) return err({ code: "FORBIDDEN" });

        const replaced = live.value.length >= MAX_DEVICES;
        if (replaced) {
            const replaceable = await mayReplaceItself(tx, accountId, txNow);
            if (!replaceable.ok) return replaceable;
            if (!replaceable.value) return err({ code: "FORBIDDEN" });
            const revoked = await execute(
                tx,
                sql`update device set revoked_at = ${toTimestamptz(txNow)}::timestamptz
                    where account_id = ${accountId} and revoked_at is null`,
            );
            if (!revoked.ok) return revoked;
            const window = await startChangeWindow(tx, accountId, txNow);
            if (!window.ok) return window;
        }
        const inserted = await execute(
            tx,
            sql`insert into device (id, account_id, jkt, public_key, storage, enrolled_at)
                values (${deviceId}, ${accountId}, ${enrollment.value.jkt},
                        ${JSON.stringify(enrollment.value.public_key)}::jsonb,
                        ${enrollment.value.storage}, ${toTimestamptz(txNow)}::timestamptz)`,
        );
        if (!inserted.ok) return inserted;
        const decided = await execute(
            tx,
            sql`update device_enrollment
                set state = 'approved', device_id = ${deviceId},
                    decided_at = ${toTimestamptz(txNow)}::timestamptz
                where id = ${params.enrollmentId}`,
        );
        if (!decided.ok) return decided;
        const approved = { deviceId: toHex(deviceId), replaced };
        const recorded = await recordReceipt(tx, op, approved);
        if (!recorded.ok) return recorded;
        return ok(approved);
    });
}

// Denying needs no fresh factor: it binds nothing.
export async function denyEnrollment(
    db: Db,
    params: { readonly sessionToken: BearerToken; readonly enrollmentId: Uint8Array },
): Promise<Result<void, SessionInvalid | NotFound | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const enrollment = await lockPendingEnrollment(tx, {
            accountId: session.value.accountId,
            enrollmentId: params.enrollmentId,
            txNow,
        });
        if (!enrollment.ok) return enrollment;
        const denied = await execute(
            tx,
            sql`update device_enrollment
                set state = 'denied', decided_at = ${toTimestamptz(txNow)}::timestamptz
                where id = ${params.enrollmentId}`,
        );
        if (!denied.ok) return denied;
        return ok(undefined);
    });
}

export type ListedDevice = {
    readonly deviceId: string;
    readonly name: string | null;
    readonly matchCode: string;
    readonly storage: KeyStorage;
    readonly enrolledAt: EpochMs;
    // The last lease a module on this PC was given: the server's own record of the PC in use.
    readonly lastSeenAt: EpochMs | null;
};

export type DeviceList = {
    readonly devices: readonly ListedDevice[];
    readonly limit: number;
    // When the member may next replace or remove a device themselves; null when they may now.
    readonly replaceableFrom: EpochMs | null;
};

const ListedDeviceRowSchema = z.object({
    id: Bytes,
    name: z.string().nullable(),
    jkt: z.string(),
    storage: Storage,
    enrolled_at: EpochMs,
    last_seen_at: EpochMs.nullable(),
});

// An account's live devices and its replacement window, for the member and for staff alike.
// Software-backed keys are marked: both see which PCs had no usable TPM.
export async function readAccountDevices(
    q: Queryable,
    params: { readonly accountId: AccountId; readonly txNow: EpochMs },
): Promise<Result<DeviceList, DbFailure>> {
    const rows = await queryAll(
        q,
        ListedDeviceRowSchema,
        sql`select d.id, d.name, d.jkt, d.storage, d.enrolled_at,
                   (select max(s.lease_issued_at) from runtime_session s
                    where s.account_id = d.account_id and s.device_id = d.id) as last_seen_at
            from device d
            where d.account_id = ${params.accountId} and d.revoked_at is null
            order by d.enrolled_at, d.id`,
    );
    if (!rows.ok) return rows;
    const window = await queryOne(
        q,
        z.object({ last_replaced_at: EpochMs }),
        sql`select last_replaced_at from device_change_window where account_id = ${params.accountId}`,
    );
    if (!window.ok) return window;
    const from =
        window.value === null
            ? null
            : EpochMs.parse(window.value.last_replaced_at + SELF_SERVICE_REPLACEMENT_MS);
    return ok({
        devices: rows.value.map((row) => ({
            deviceId: toHex(row.id),
            name: row.name,
            matchCode: matchCodeOf(row.jkt),
            storage: row.storage,
            enrolledAt: row.enrolled_at,
            lastSeenAt: row.last_seen_at,
        })),
        limit: MAX_DEVICES,
        replaceableFrom: from !== null && from > params.txNow ? from : null,
    });
}

export async function listDevices(
    db: Db,
    params: { readonly sessionToken: BearerToken },
): Promise<Result<DeviceList, SessionInvalid | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        return await readAccountDevices(tx, { accountId: session.value.accountId, txNow });
    });
}

// A name is the member's own label; changing it binds nothing, so it needs no fresh factor.
export async function renameDevice(
    db: Db,
    params: {
        readonly sessionToken: BearerToken;
        readonly deviceId: Uint8Array;
        readonly name: string | null;
    },
): Promise<Result<void, SessionInvalid | NotFound | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const renamed = await queryOne(
            tx,
            z.object({ id: Bytes }),
            sql`update device set name = ${params.name}
                where id = ${params.deviceId} and account_id = ${session.value.accountId}
                  and revoked_at is null
                returning id`,
        );
        if (!renamed.ok) return renamed;
        if (renamed.value === null) return err({ code: "NOT_FOUND" });
        return ok(undefined);
    });
}

type TooSoon = { readonly code: "DEVICE_CHANGE_TOO_SOON" };

const RemovedReceipt = z.object({ removed: z.literal(true) });

// The member takes a PC off their account, having proven a factor in the last few minutes. It
// counts as their self-service change: refused while the window is closed, and it starts the
// window. Otherwise removing one PC and enrolling another would replace a PC as often as anyone
// liked, since enrolling below the limit consults no window. The PC's running sessions end at
// their next renewal, which refuses a revoked device.
export async function removeDevice(
    db: Db,
    params: {
        readonly sessionToken: BearerToken;
        readonly operationId: OperationId;
        readonly deviceId: Uint8Array;
    },
): Promise<Result<void, SessionRefusal | NotFound | TooSoon | ReceiptRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const fresh = requireFresh(session.value, txNow);
        if (!fresh.ok) return fresh;
        const { accountId } = session.value;
        const op = await toOperationKey({
            principal: `account:${accountId}`,
            endpoint: "devices.remove",
            operationId: params.operationId,
            payload: { deviceId: toHex(params.deviceId) },
        });
        const live = await lockLiveDevices(tx, accountId);
        if (!live.ok) return live;

        const replay = await readReplay(tx, op, RemovedReceipt);
        if (!replay.ok) return replay;
        if (replay.value.replayed) return ok(undefined);

        if (!live.value.some((id) => toHex(id) === toHex(params.deviceId))) {
            return err({ code: "NOT_FOUND" });
        }
        const allowed = await mayReplaceItself(tx, accountId, txNow);
        if (!allowed.ok) return allowed;
        if (!allowed.value) return err({ code: "DEVICE_CHANGE_TOO_SOON" });

        const revoked = await execute(
            tx,
            sql`update device set revoked_at = ${toTimestamptz(txNow)}::timestamptz
                where id = ${params.deviceId}`,
        );
        if (!revoked.ok) return revoked;
        const window = await startChangeWindow(tx, accountId, txNow);
        if (!window.ok) return window;
        const recorded = await recordReceipt(tx, op, { removed: true });
        if (!recorded.ok) return recorded;
        return ok(undefined);
    });
}
