import type { ModuleKey } from "@lucent/bundle/fact-set";
import { parseReleaseManifestV3 } from "@lucent/bundle/release-manifest";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import {
    AccountId,
    EpochMs,
    type OperationId,
    ProductId,
    toBase64Url,
    toHex,
} from "@lucent/core/scalars";
import { parseDataRequest } from "@lucent/wire/data";
import { type Frame, openFrame, toFrameBytes } from "@lucent/wire/frame";
import { parseLeaseRenewal } from "@lucent/wire/lease";
import type { LeaseRequest } from "@lucent/wire/lease-exchange";
import { deriveSessionKeys, type SessionHello } from "@lucent/wire/session";
import { exchangePublicKey, sharedSecret } from "@lucent/wire/session-crypto";
import { z } from "zod";
import { readEffectiveProductAccess } from "../authority/entitlements.ts";
import {
    type Db,
    type DbFailure,
    execute,
    queryOne,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { type ReceiptRefusal, readReplay, recordReceipt, toOperationKey } from "../db/receipt.ts";
import { errCommit, withTx } from "../db/tx.ts";
import { type AccountInactive, lockAccountStanding, lockActiveAccount } from "./accounts.ts";
import {
    assembleData,
    type DataTooLarge,
    FIRST_DATA_ANSWERS,
    FIRST_DATA_SEQUENCE,
    sealData,
} from "./data.ts";
import { lockDevice } from "./devices.ts";
import type { DpopProof } from "./dpop.ts";
import { readFactDelivery } from "./fact-sets.ts";
import { newWireId } from "./ids.ts";
import type { LeaseSigner } from "./lease-key.ts";
import {
    entitledFeaturesOf,
    LEASE_DURATION_MS,
    type LeaseState,
    newChallenge,
    RESUME_WINDOW_MS,
    SESSION_CAP_MS,
    toLeaseResponse,
    toSessionReply,
} from "./leases.ts";
import { findReleaseManifest } from "./releases.ts";
import type { TokenHolder } from "./sign-in.ts";
import { StartModules } from "./starts.ts";

// A module's session: its hello consumes the start and takes the product slot; its renewals keep
// the lease; close or a lapsed lease ends it. Every refusal that ends a session commits the end,
// so the answer stays the same however often the loader retries.

const Bytes = z.instanceof(Uint8Array);
const U64 = z.coerce.bigint();
const U32 = z.coerce.number().int().nonnegative();

type Code<C extends string> = { readonly code: C };

type EndReason = "closed" | "slot_taken" | "suspended" | "device_revoked" | "expired" | "capped";

const SessionRowSchema = z.object({
    id: Bytes,
    account_id: AccountId,
    device_id: Bytes,
    product_id: z.string(),
    release_id: Bytes,
    slot_generation: U64,
    module_key: Bytes,
    server_key: Bytes,
    key_to_server: Bytes.nullable(),
    key_to_module: Bytes.nullable(),
    image_size: U32,
    entitled_everything: z.boolean(),
    entitled_features: z.array(U64),
    created_at: EpochMs,
    lease_sequence: U64,
    lease_nonce: Bytes,
    lease_challenge_nonce: Bytes,
    lease_challenge_offset: U32,
    lease_challenge_size: U32,
    loader_challenge_nonce: Bytes,
    loader_challenge_offset: U32,
    loader_challenge_size: U32,
    lease_expires_at: EpochMs,
    frame_in_sequence: U64,
    frame_out_sequence: U64,
    data_key_to_server: Bytes.nullable(),
    data_key_to_module: Bytes.nullable(),
    data_in_sequence: U64,
    data_out_sequence: U64,
    end_reason: z
        .enum(["closed", "slot_taken", "suspended", "device_revoked", "expired", "capped"])
        .nullable(),
});
type SessionRow = z.output<typeof SessionRowSchema>;

const SESSION_COLUMNS = sql`id, account_id, device_id, product_id, release_id, slot_generation,
    module_key, server_key, key_to_server, key_to_module, image_size, entitled_everything,
    entitled_features, created_at, lease_sequence, lease_nonce, lease_challenge_nonce,
    lease_challenge_offset, lease_challenge_size, loader_challenge_nonce, loader_challenge_offset,
    loader_challenge_size, lease_expires_at, frame_in_sequence, frame_out_sequence,
    data_key_to_server, data_key_to_module, data_in_sequence, data_out_sequence, end_reason`;

function leaseStateOf(row: SessionRow): LeaseState {
    invariant(row.key_to_module !== null, "a live session holds its keys");
    return {
        session: row.id,
        device: row.device_id,
        release: row.release_id,
        product: row.product_id,
        sequence: row.lease_sequence,
        nonce: row.lease_nonce,
        challenge: {
            nonce: row.lease_challenge_nonce,
            offset: row.lease_challenge_offset,
            size: row.lease_challenge_size,
        },
        loaderChallenge: {
            nonce: row.loader_challenge_nonce,
            offset: row.loader_challenge_offset,
            size: row.loader_challenge_size,
        },
        entitled: row.entitled_everything
            ? { everything: true }
            : { everything: false, features: row.entitled_features },
        keyToModule: row.key_to_module,
        frameSequence: row.frame_out_sequence,
    };
}

type Slot = { readonly generation: bigint; readonly holder: Uint8Array | null };

// Fourth in the canonical lock order, after account, device and entitlement.
async function lockSlot(
    tx: Tx,
    params: { readonly accountId: AccountId; readonly productId: string },
): Promise<Result<Slot, DbFailure>> {
    const created = await execute(
        tx,
        sql`insert into product_slot (account_id, product_id)
            values (${params.accountId}, ${params.productId}) on conflict do nothing`,
    );
    if (!created.ok) return created;
    const row = await queryOne(
        tx,
        z.object({ generation: U64, holder_session: Bytes.nullable() }),
        sql`select generation, holder_session from product_slot
            where account_id = ${params.accountId} and product_id = ${params.productId}
            for update`,
    );
    if (!row.ok) return row;
    invariant(row.value !== null, "a slot exists once inserted");
    return ok({ generation: row.value.generation, holder: row.value.holder_session });
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
    return left !== null && toHex(left) === toHex(right);
}

async function findSession(
    tx: Tx,
    params: {
        readonly sessionId: Uint8Array;
        readonly accountId: AccountId;
        readonly lock: "for update" | "no lock";
    },
): Promise<Result<SessionRow | null, DbFailure>> {
    return await queryOne(
        tx,
        SessionRowSchema,
        sql`select ${SESSION_COLUMNS} from runtime_session
            where id = ${params.sessionId} and account_id = ${params.accountId}
            ${params.lock === "for update" ? sql`for update` : sql``}`,
    );
}

// Ends the session (its keys wiped) and frees the slot when it still held it.
async function endSession(
    tx: Tx,
    params: {
        readonly session: SessionRow;
        readonly slot: Slot;
        readonly reason: EndReason;
        readonly txNow: EpochMs;
    },
): Promise<Result<void, DbFailure>> {
    const ended = await execute(
        tx,
        sql`update runtime_session
            set ended_at = ${toTimestamptz(params.txNow)}::timestamptz, end_reason = ${params.reason},
                key_to_server = null, key_to_module = null,
                data_key_to_server = null, data_key_to_module = null
            where id = ${params.session.id} and ended_at is null`,
    );
    if (!ended.ok) return ended;
    if (!sameBytes(params.slot.holder, params.session.id)) return ok(undefined);
    const freed = await execute(
        tx,
        sql`update product_slot set holder_session = null
            where account_id = ${params.session.account_id} and product_id = ${params.session.product_id}`,
    );
    if (!freed.ok) return freed;
    return ok(undefined);
}

export type SessionEnded = Code<
    "SESSION_ENDED" | "SLOT_TAKEN" | "ACCOUNT_SUSPENDED" | "DEVICE_REVOKED"
>;

// What an ended session answers from then on: the reason it ended, where the loader shows one.
function endedRefusal(reason: EndReason): SessionEnded {
    switch (reason) {
        case "slot_taken":
            return { code: "SLOT_TAKEN" };
        case "suspended":
            return { code: "ACCOUNT_SUSPENDED" };
        case "device_revoked":
            return { code: "DEVICE_REVOKED" };
        case "closed":
        case "expired":
        case "capped":
            return { code: "SESSION_ENDED" };
    }
}

// A data response that no frame can carry: the server's own failure, shown as unavailable and
// logged by the route, never a refusal of the member.
export type DataUnsendable = DataTooLarge;

// The data_response the session reply carries: the sets for the start's own builds.
async function assembleFirstData(
    tx: Tx,
    releaseId: Uint8Array,
    startBuilds: readonly ModuleKey[],
): Promise<Result<Uint8Array<ArrayBuffer>, DataUnsendable | DbFailure>> {
    const delivery = await readFactDelivery(tx, { releaseId, builds: startBuilds });
    if (!delivery.ok) return delivery;
    return assembleData({ answers: FIRST_DATA_ANSWERS, delivery: delivery.value });
}

export type OpenRefusal =
    | AccountInactive
    | ReceiptRefusal
    | SessionEnded
    | DataUnsendable
    | Code<
          | "NOT_FOUND"
          | "INVALID_REQUEST"
          | "START_MISMATCH"
          | "START_EXPIRED"
          | "ENTITLEMENT_INACTIVE"
          | "CHANNEL_NOT_ALLOWED"
          | "STALE_SEQUENCE"
      >;

const SessionReceipt = z.object({ session: z.string().regex(/^[0-9a-f]{32}$/) });

const StartRowSchema = z.object({
    device_id: Bytes,
    product_id: z.string(),
    channel: z.string(),
    release_id: Bytes,
    expires_at: EpochMs,
    consumed_at: EpochMs.nullable(),
    modules: StartModules,
});

// POST /v1/starts/:id/session: the module's hello, relayed by the loader. Binds the module's
// key, consumes the start and takes the slot from whoever held it; the reply is the server's half
// of the exchange and the first lease. The exchange is computed before the transaction and signed
// after it commits, so nothing waits on the lock while crypto runs and nothing is signed for a
// session that wasn't recorded.
export async function openSession(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly catalog: ProductCatalog;
        readonly signer: LeaseSigner;
        readonly holder: TokenHolder;
        readonly proof: DpopProof;
        readonly startId: Uint8Array;
        readonly hello: SessionHello;
        readonly operationId: OperationId;
    },
): Promise<Result<Uint8Array<ArrayBuffer>, OpenRefusal | DbFailure>> {
    const { hello, rng } = params;
    const { accountId } = params.holder;
    if (hello.boot.imageSize === 0) return err({ code: "INVALID_REQUEST" });
    const seed = rng.fillBytes(new Uint8Array(32));
    const serverKey = await exchangePublicKey(seed);
    const shared = await sharedSecret(seed, hello.moduleKey);
    seed.fill(0);
    if (!shared.ok) return err({ code: "INVALID_REQUEST" });
    const keys = deriveSessionKeys({ shared: shared.value, moduleKey: hello.moduleKey, serverKey });
    shared.value.fill(0);
    const sessionId = newWireId(rng);
    const challenge = newChallenge(rng, hello.boot.imageSize);
    const loaderChallenge = newChallenge(rng, hello.boot.imageSize);
    const op = await toOperationKey({
        principal: `account:${accountId}`,
        endpoint: "v1.starts.session",
        operationId: params.operationId,
        payload: {
            start: toHex(params.startId),
            moduleKey: toBase64Url(hello.moduleKey),
            nonce: toBase64Url(hello.nonce),
            release: toHex(hello.release),
            boot: [
                hello.boot.bootInfoVersion,
                hello.boot.imageKind,
                hello.boot.imageBase.toString(),
                hello.boot.imageSize,
            ],
        },
    });

    const opened = await withTx(db, async (tx, txNow) => {
        const startRow = await queryOne(
            tx,
            StartRowSchema,
            sql`select device_id, product_id, channel, release_id, expires_at, consumed_at, modules
                from session_start where id = ${params.startId} and account_id = ${accountId}`,
        );
        if (!startRow.ok) return startRow;
        if (startRow.value === null) return err({ code: "NOT_FOUND" });
        const start = startRow.value;

        const account = await lockActiveAccount(tx, accountId, txNow);
        if (!account.ok) return account;
        const device = await lockDevice(tx, start.device_id);
        if (!device.ok) return device;
        if (device.value.revokedAt !== null) return err({ code: "DEVICE_REVOKED" });
        if (device.value.jkt !== params.proof.jkt) return err({ code: "START_MISMATCH" });
        const product = params.catalog.get(ProductId.parse(start.product_id));
        invariant(product !== undefined, "a start's product is in the catalog");
        const access = await readEffectiveProductAccess(tx, { accountId, product, at: txNow });
        if (!access.ok) return access;
        if (!access.value.isEntitled) return err({ code: "ENTITLEMENT_INACTIVE" });
        if (!access.value.channels.some((channel) => channel === start.channel)) {
            return err({ code: "CHANNEL_NOT_ALLOWED" });
        }
        const slot = await lockSlot(tx, { accountId, productId: start.product_id });
        if (!slot.ok) return slot;
        const lockedStart = await queryOne(
            tx,
            z.object({ consumed_at: EpochMs.nullable() }),
            sql`select consumed_at from session_start where id = ${params.startId} for update`,
        );
        if (!lockedStart.ok) return lockedStart;

        const replay = await readReplay(tx, op, SessionReceipt);
        if (!replay.ok) return replay;
        if (replay.value.replayed) {
            const replayed = await findSession(tx, {
                sessionId: Uint8Array.fromHex(replay.value.result.session),
                accountId,
                lock: "no lock",
            });
            if (!replayed.ok) return replayed;
            invariant(replayed.value !== null, "a receipt's session exists");
            const row = replayed.value;
            if (row.end_reason !== null) return err(endedRefusal(row.end_reason));
            if (row.lease_sequence !== 1n) return err({ code: "STALE_SEQUENCE" });
            const plain = await assembleFirstData(tx, row.release_id, start.modules);
            if (!plain.ok) return plain;
            return ok({ session: row, plain: plain.value });
        }

        if (lockedStart.value?.consumed_at !== null || start.expires_at <= txNow) {
            return err({ code: "START_EXPIRED" });
        }
        if (toHex(hello.release) !== toHex(start.release_id))
            return err({ code: "START_MISMATCH" });
        const manifestBytes = await findReleaseManifest(tx, start.release_id);
        if (!manifestBytes.ok) return manifestBytes;
        invariant(manifestBytes.value !== null, "a started release has a manifest");
        const manifest = parseReleaseManifestV3(manifestBytes.value);
        invariant(manifest.ok, "a published release manifest parses");
        const entitled = entitledFeaturesOf(access.value.features, manifest.value);
        // Before the start is consumed: a response no frame can carry must leave it usable.
        const plain = await assembleFirstData(tx, start.release_id, start.modules);
        if (!plain.ok) return plain;

        const generation = slot.value.generation + 1n;
        const took = await execute(
            tx,
            sql`update product_slot set generation = ${generation}, holder_session = ${sessionId}
                where account_id = ${accountId} and product_id = ${start.product_id}`,
        );
        if (!took.ok) return took;
        const consumed = await execute(
            tx,
            sql`update session_start
                set consumed_at = ${toTimestamptz(txNow)}::timestamptz, container_key = null
                where id = ${params.startId}`,
        );
        if (!consumed.ok) return consumed;
        const inserted = await queryOne(
            tx,
            SessionRowSchema,
            sql`insert into runtime_session
                    (id, start_id, account_id, device_id, product_id, channel, release_id,
                     slot_generation, module_key, server_key, key_to_server, key_to_module,
                     boot_info_version, image_kind, image_base, image_size, entitled_everything,
                     entitled_features, created_at, lease_sequence, lease_nonce,
                     lease_challenge_nonce, lease_challenge_offset, lease_challenge_size,
                     loader_challenge_nonce, loader_challenge_offset, loader_challenge_size,
                     lease_issued_at, lease_expires_at, frame_in_sequence, frame_out_sequence,
                     data_key_to_server, data_key_to_module)
                values (${sessionId}, ${params.startId}, ${accountId}, ${start.device_id},
                        ${start.product_id}, ${start.channel}, ${start.release_id}, ${generation},
                        ${hello.moduleKey}, ${serverKey}, ${keys.lease.moduleToServer},
                        ${keys.lease.serverToModule}, ${hello.boot.bootInfoVersion},
                        ${hello.boot.imageKind}, ${hello.boot.imageBase}, ${hello.boot.imageSize},
                        ${entitled.everything},
                        ${entitled.everything ? [] : entitled.features}::numeric[],
                        ${toTimestamptz(txNow)}::timestamptz, 1, ${hello.nonce},
                        ${challenge.nonce}, ${challenge.offset}, ${challenge.size},
                        ${loaderChallenge.nonce}, ${loaderChallenge.offset}, ${loaderChallenge.size},
                        ${toTimestamptz(txNow)}::timestamptz,
                        ${toTimestamptz(EpochMs.parse(txNow + LEASE_DURATION_MS))}::timestamptz,
                        0, 1, ${keys.data.moduleToServer}, ${keys.data.serverToModule})
                returning ${SESSION_COLUMNS}`,
        );
        if (!inserted.ok) return inserted;
        invariant(inserted.value !== null, "insert returning yields its row");
        const recorded = await recordReceipt(tx, op, { session: toHex(sessionId) });
        if (!recorded.ok) return recorded;
        return ok({ session: inserted.value, plain: plain.value });
    });
    // The lease and data routes' keys are stored; the reports route's wait for something that
    // serves it.
    for (const route of [keys.lease, keys.data, keys.reports]) {
        route.moduleToServer.fill(0);
        route.serverToModule.fill(0);
    }
    if (!opened.ok) return opened;
    const { session, plain } = opened.value;
    invariant(session.data_key_to_module !== null, "a live session holds its keys");
    return ok(
        await toSessionReply({
            signer: params.signer,
            rng,
            state: leaseStateOf(session),
            moduleKey: session.module_key,
            serverKey: session.server_key,
            firstData: sealData({
                rng,
                key: session.data_key_to_module,
                session: session.id,
                sequence: FIRST_DATA_SEQUENCE,
                plain,
            }),
        }),
    );
}

export type RenewRefusal =
    | ReceiptRefusal
    | SessionEnded
    | Code<"NOT_FOUND" | "INVALID_REQUEST" | "STALE_SEQUENCE" | "PROOF_INVALID">;

const RenewalReceipt = z.object({ sequence: z.string().regex(/^\d+$/) });

// Every session check, in the order that names the most useful reason: suspension first, then the
// PC, then whoever took the slot, then time. No integrity check: what the module and loader report
// is stored as received and never changes what they see.
function endReasonOf(params: {
    readonly session: SessionRow;
    readonly slot: Slot;
    readonly accountActive: boolean;
    readonly deviceRevoked: boolean;
    readonly txNow: EpochMs;
}): EndReason | null {
    const { session, txNow } = params;
    if (!params.accountActive) return "suspended";
    if (params.deviceRevoked) return "device_revoked";
    if (params.slot.generation !== session.slot_generation) return "slot_taken";
    if (session.lease_expires_at + RESUME_WINDOW_MS <= txNow) return "expired";
    if (session.created_at + SESSION_CAP_MS <= txNow) return "capped";
    return null;
}

// POST /v1/sessions/:id/lease: the loader's DPoP around the module's frame. The renewal asks for
// the next lease (the held one's sequence plus one) in a frame newer than any accepted; the reply
// is that lease, signed and sealed, valid for another minute.
export async function renewLease(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly signer: LeaseSigner;
        readonly holder: TokenHolder;
        readonly proof: DpopProof;
        readonly sessionId: Uint8Array;
        readonly request: LeaseRequest;
        readonly body: Uint8Array;
        readonly operationId: OperationId;
    },
): Promise<Result<Uint8Array<ArrayBuffer>, RenewRefusal | DbFailure>> {
    const { accountId } = params.holder;
    const frame = params.request.renewal;
    if (toHex(frame.header.session) !== toHex(params.sessionId)) {
        return err({ code: "INVALID_REQUEST" });
    }
    const op = await toOperationKey({
        principal: `account:${accountId}`,
        endpoint: "v1.sessions.lease",
        operationId: params.operationId,
        payload: { session: toHex(params.sessionId), body: toBase64Url(params.body) },
    });

    const renewed = await withTx(db, async (tx, txNow) => {
        const found = await findSession(tx, {
            sessionId: params.sessionId,
            accountId,
            lock: "no lock",
        });
        if (!found.ok) return found;
        if (found.value === null) return err({ code: "NOT_FOUND" });
        const standing = await lockAccountStanding(tx, accountId, txNow);
        if (!standing.ok) return standing;
        const device = await lockDevice(tx, found.value.device_id);
        if (!device.ok) return device;
        if (device.value.jkt !== params.proof.jkt) return err({ code: "NOT_FOUND" });
        const slot = await lockSlot(tx, { accountId, productId: found.value.product_id });
        if (!slot.ok) return slot;
        const locked = await findSession(tx, {
            sessionId: params.sessionId,
            accountId,
            lock: "for update",
        });
        if (!locked.ok) return locked;
        invariant(locked.value !== null, "a session found a moment ago exists under lock");
        const session = locked.value;
        if (session.end_reason !== null) return err(endedRefusal(session.end_reason));

        const replay = await readReplay(tx, op, RenewalReceipt);
        if (!replay.ok) return replay;
        if (replay.value.replayed) {
            return BigInt(replay.value.result.sequence) === session.lease_sequence
                ? ok(session)
                : err({ code: "STALE_SEQUENCE" });
        }

        const reason = endReasonOf({
            session,
            slot: slot.value,
            accountActive: standing.value === "active",
            deviceRevoked: device.value.revokedAt !== null,
            txNow,
        });
        if (reason !== null) {
            const ended = await endSession(tx, { session, slot: slot.value, reason, txNow });
            if (!ended.ok) return ended;
            return errCommit(endedRefusal(reason));
        }

        if (frame.header.sequence <= session.frame_in_sequence)
            return err({ code: "STALE_SEQUENCE" });
        invariant(session.key_to_server !== null, "a live session holds its keys");
        const plain = openFrame(session.key_to_server, frame);
        if (!plain.ok) return err({ code: "PROOF_INVALID" });
        const renewal = parseLeaseRenewal(plain.value);
        plain.value.fill(0);
        if (!renewal.ok) return err({ code: "INVALID_REQUEST" });
        const sequence = session.lease_sequence + 1n;
        if (renewal.value.sequence !== sequence) return err({ code: "STALE_SEQUENCE" });

        const stored = await execute(
            tx,
            sql`insert into lease_renewal
                    (session_id, sequence, received_at, signals, module_answer, loader_answer)
                values (${session.id}, ${sequence}, ${toTimestamptz(txNow)}::timestamptz,
                        ${renewal.value.signals}, ${renewal.value.challengeAnswer},
                        ${params.request.loaderAnswer})`,
        );
        if (!stored.ok) return stored;
        const challenge = newChallenge(params.rng, session.image_size);
        const loaderChallenge = newChallenge(params.rng, session.image_size);
        const updated = await queryOne(
            tx,
            SessionRowSchema,
            sql`update runtime_session
                set lease_sequence = ${sequence}, lease_nonce = ${renewal.value.nonce},
                    lease_challenge_nonce = ${challenge.nonce},
                    lease_challenge_offset = ${challenge.offset},
                    lease_challenge_size = ${challenge.size},
                    loader_challenge_nonce = ${loaderChallenge.nonce},
                    loader_challenge_offset = ${loaderChallenge.offset},
                    loader_challenge_size = ${loaderChallenge.size},
                    lease_issued_at = ${toTimestamptz(txNow)}::timestamptz,
                    lease_expires_at = ${toTimestamptz(EpochMs.parse(txNow + LEASE_DURATION_MS))}::timestamptz,
                    frame_in_sequence = ${frame.header.sequence},
                    frame_out_sequence = frame_out_sequence + 1
                where id = ${session.id}
                returning ${SESSION_COLUMNS}`,
        );
        if (!updated.ok) return updated;
        invariant(updated.value !== null, "update returning yields its row");
        const recorded = await recordReceipt(tx, op, { sequence: sequence.toString() });
        if (!recorded.ok) return recorded;
        return ok(updated.value);
    });
    if (!renewed.ok) return renewed;
    return ok(
        await toLeaseResponse({
            signer: params.signer,
            rng: params.rng,
            state: leaseStateOf(renewed.value),
        }),
    );
}

const DataReceipt = z.object({ sequence: z.string().regex(/^\d+$/) });

// POST /v1/sessions/:id/data: the loader's DPoP around the module's data_request frame, which must
// be newer than any accepted on the data route (its sequences are its own: a renewal never stales
// it). The reply is a data_response for the builds it names, sealed as the next frame the server
// sends on that route; the builds needn't have been reported at start, since late-loaded modules
// ask too, and a set applies when each build it lists is asked or was reported at start. Phase 1
// ignores the request's feature list. A retry gets the response rebuilt from the same builds at
// the same sequence, so it is the first answer unless a set was promoted since. A response over
// the frame bound is refused before the receipt, so the request stays unanswered.
export async function serveData(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly holder: TokenHolder;
        readonly proof: DpopProof;
        readonly sessionId: Uint8Array;
        readonly frame: Frame;
        readonly body: Uint8Array;
        readonly operationId: OperationId;
    },
): Promise<Result<Uint8Array<ArrayBuffer>, RenewRefusal | DataUnsendable | DbFailure>> {
    const { accountId } = params.holder;
    const { frame } = params;
    if (
        toHex(frame.header.session) !== toHex(params.sessionId) ||
        frame.header.direction !== "module_to_server"
    ) {
        return err({ code: "INVALID_REQUEST" });
    }
    const op = await toOperationKey({
        principal: `account:${accountId}`,
        endpoint: "v1.sessions.data",
        operationId: params.operationId,
        payload: { session: toHex(params.sessionId), body: toBase64Url(params.body) },
    });

    const served = await withTx(db, async (tx, txNow) => {
        const found = await findSession(tx, {
            sessionId: params.sessionId,
            accountId,
            lock: "no lock",
        });
        if (!found.ok) return found;
        if (found.value === null) return err({ code: "NOT_FOUND" });
        const standing = await lockAccountStanding(tx, accountId, txNow);
        if (!standing.ok) return standing;
        const device = await lockDevice(tx, found.value.device_id);
        if (!device.ok) return device;
        if (device.value.jkt !== params.proof.jkt) return err({ code: "NOT_FOUND" });
        const slot = await lockSlot(tx, { accountId, productId: found.value.product_id });
        if (!slot.ok) return slot;
        const locked = await findSession(tx, {
            sessionId: params.sessionId,
            accountId,
            lock: "for update",
        });
        if (!locked.ok) return locked;
        invariant(locked.value !== null, "a session found a moment ago exists under lock");
        const session = locked.value;
        if (session.end_reason !== null) return err(endedRefusal(session.end_reason));

        const replay = await readReplay(tx, op, DataReceipt);
        if (!replay.ok) return replay;
        const replayed = replay.value.replayed ? BigInt(replay.value.result.sequence) : null;
        if (replayed !== null && replayed !== session.data_out_sequence - 1n) {
            return err({ code: "STALE_SEQUENCE" });
        }

        const reason = endReasonOf({
            session,
            slot: slot.value,
            accountActive: standing.value === "active",
            deviceRevoked: device.value.revokedAt !== null,
            txNow,
        });
        if (reason !== null) {
            const ended = await endSession(tx, { session, slot: slot.value, reason, txNow });
            if (!ended.ok) return ended;
            return errCommit(endedRefusal(reason));
        }

        if (replayed === null && frame.header.sequence <= session.data_in_sequence) {
            return err({ code: "STALE_SEQUENCE" });
        }
        invariant(session.data_key_to_server !== null, "a live session holds its keys");
        const plain = openFrame(session.data_key_to_server, frame);
        if (!plain.ok) return err({ code: "PROOF_INVALID" });
        const request = parseDataRequest(plain.value);
        plain.value.fill(0);
        if (!request.ok) return err({ code: "INVALID_REQUEST" });
        const started = await queryOne(
            tx,
            z.object({ modules: StartModules }),
            sql`select s.modules from runtime_session r join session_start s on s.id = r.start_id
                where r.id = ${session.id}`,
        );
        if (!started.ok) return started;
        invariant(started.value !== null, "a session's start exists");
        const delivery = await readFactDelivery(tx, {
            releaseId: session.release_id,
            builds: request.value.modules,
            loaded: started.value.modules,
        });
        if (!delivery.ok) return delivery;
        const answer = assembleData({ answers: frame.header.sequence, delivery: delivery.value });
        if (!answer.ok) return answer;
        if (replayed !== null) return ok({ session, answer: answer.value, sequence: replayed });

        const sequence = session.data_out_sequence;
        const advanced = await execute(
            tx,
            sql`update runtime_session
                set data_in_sequence = ${frame.header.sequence},
                    data_out_sequence = data_out_sequence + 1
                where id = ${session.id}`,
        );
        if (!advanced.ok) return advanced;
        const recorded = await recordReceipt(tx, op, { sequence: sequence.toString() });
        if (!recorded.ok) return recorded;
        return ok({ session, answer: answer.value, sequence });
    });
    if (!served.ok) return served;
    const { session, answer, sequence } = served.value;
    invariant(session.data_key_to_module !== null, "a live session holds its keys");
    return ok(
        toFrameBytes(
            sealData({
                rng: params.rng,
                key: session.data_key_to_module,
                session: session.id,
                sequence,
                plain: answer,
            }),
        ),
    );
}

// POST /v1/sessions/:id/close: the loader ends the session (the game or the module is gone) and
// the slot frees at once; a session already ended stays as it ended. Closing needs no standing:
// a suspended account's loader may still let go.
export async function closeSession(
    db: Db,
    params: {
        readonly holder: TokenHolder;
        readonly proof: DpopProof;
        readonly sessionId: Uint8Array;
    },
): Promise<Result<void, Code<"NOT_FOUND"> | DbFailure>> {
    const { accountId } = params.holder;
    return await withTx(db, async (tx, txNow) => {
        const found = await findSession(tx, {
            sessionId: params.sessionId,
            accountId,
            lock: "no lock",
        });
        if (!found.ok) return found;
        if (found.value === null) return err({ code: "NOT_FOUND" });
        const standing = await lockAccountStanding(tx, accountId, txNow);
        if (!standing.ok) return standing;
        const device = await lockDevice(tx, found.value.device_id);
        if (!device.ok) return device;
        if (device.value.jkt !== params.proof.jkt) return err({ code: "NOT_FOUND" });
        const slot = await lockSlot(tx, { accountId, productId: found.value.product_id });
        if (!slot.ok) return slot;
        const locked = await findSession(tx, {
            sessionId: params.sessionId,
            accountId,
            lock: "for update",
        });
        if (!locked.ok) return locked;
        invariant(locked.value !== null, "a session found a moment ago exists under lock");
        if (locked.value.end_reason !== null) return ok(undefined);
        return await endSession(tx, {
            session: locked.value,
            slot: slot.value,
            reason: "closed",
            txNow,
        });
    });
}
