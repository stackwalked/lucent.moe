import type { ModuleKey } from "@lucent/bundle/fact-set";
import { parseModuleManifest } from "@lucent/bundle/release-manifest";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import { EpochMs, type OperationId, toHex } from "@lucent/core/scalars";
import { CONTAINER_KEY_SIZE, type StartReply, type StartRequest } from "@lucent/wire/start";
import { z } from "zod";
import type { AccountInactive } from "../authority/accounts.ts";
import { readEffectiveProductAccess } from "../authority/entitlements.ts";
import { newWireId } from "../core/ids.ts";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryOne,
    sql,
    toTimestamptz,
} from "../db/pool.ts";
import { type ReceiptRefusal, readReplay, recordReceipt, toOperationKey } from "../db/receipt.ts";
import { errCommit, withTx } from "../db/tx.ts";
import { findDeviceByKey, lockDevice } from "../devices/devices.ts";
import { type AuthRequired, lockTokenHolder, type TokenHolder } from "../devices/sign-in.ts";
import { lockBuildCoverage } from "../facts/coverage-lock.ts";
import { readCoveredFactKeys } from "../facts/publishing.ts";
import type { DpopProof } from "../listeners/native/dpop.ts";
import { recordSupportAfterReport } from "../record/support.ts";
import {
    findCurrentRelease,
    findReleaseManifest,
    LOADER_CHANNEL,
    LOADER_PRODUCT,
} from "../releases/reads.ts";
import {
    decideNeededFacts,
    decideStart,
    decideStartAccess,
    decideStartDevice,
    decideStartLoader,
    decideStartOpen,
    decideStartProduct,
    decideStartRelease,
    decideStartReplay,
    decideStartStillOpen,
} from "./starts.rules.ts";

// A start is the server's yes to running a module: every check in one transaction, then the
// release seal and a fresh key that opens this start's copy of the container. The module's hello
// consumes it; unused, it expires after a minute.

export const START_TTL_MS = 60 * 1_000;

type Code<C extends string> = { readonly code: C };

export type StartRefusal =
    | AccountInactive
    | AuthRequired
    | ReceiptRefusal
    | Code<
          | "DEVICE_REVOKED"
          | "NOT_FOUND"
          | "ENTITLEMENT_INACTIVE"
          | "CHANNEL_NOT_ALLOWED"
          | "LOADER_UPDATE_REQUIRED"
          | "RELEASE_UNAVAILABLE"
          | "GAME_BUILD_UNSUPPORTED"
          | "START_EXPIRED"
      >;

const StartReceipt = z.object({ start: z.string().regex(/^[0-9a-f]{32}$/) });

const StartRowSchema = z.object({
    container_key: z.instanceof(Uint8Array).nullable(),
    expires_at: EpochMs,
    consumed_at: EpochMs.nullable(),
    seal: z.instanceof(Uint8Array),
});

// The order is the order a member would fix things in: who they are and which PC, what they are
// entitled to, then whether the loader and the release are current. A retired product refuses
// where a missing release would. A replayed start is answered only while the account could still
// make it: after the entitlement check, and not for a product retired since. The slot never refuses (the
// newest session takes it) and is taken by the session, not here. Last comes core coverage: the
// release's current fact sets for the reported game builds must hold every fact of each core
// capability whose modules are all reported; anything less optional degrades in the module, never
// here.
export async function createStart(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly catalog: ProductCatalog;
        readonly holder: TokenHolder;
        readonly proof: DpopProof;
        readonly request: StartRequest;
        readonly operationId: OperationId;
    },
): Promise<Result<StartReply, StartRefusal | DbFailure>> {
    const { accountId } = params.holder;
    const { request } = params;
    const op = await toOperationKey({
        principal: `account:${accountId}`,
        endpoint: "v1.starts",
        operationId: params.operationId,
        payload: {
            jkt: params.proof.jkt,
            product: request.product,
            channel: request.channel,
            loaderRelease: toHex(request.loaderRelease),
            modules: request.modules.map((module) => [
                module.nameHash.toString(),
                module.timeDateStamp,
                module.sizeOfImage,
            ]),
        },
    });
    const startId = newWireId(params.rng);
    const containerKey = new Uint8Array(params.rng.fillBytes(new Uint8Array(CONTAINER_KEY_SIZE)));

    return await withTx(db, async (tx, txNow) => {
        const account = await lockTokenHolder(tx, params.holder, txNow);
        if (!account.ok) return account;
        const found = await findDeviceByKey(tx, { accountId, jkt: params.proof.jkt });
        if (!found.ok) return found;
        const candidate = decideStartDevice(found.value);
        if (!candidate.ok) return candidate;
        const device = await lockDevice(tx, candidate.value.id);
        if (!device.ok) return device;
        const lockedDevice = decideStartDevice(device.value);
        if (!lockedDevice.ok) return lockedDevice;

        const replay = await readReplay(tx, op, StartReceipt);
        if (!replay.ok) return replay;
        const selected = decideStartProduct(params.catalog, request.product);
        if (!selected.ok) return selected;
        const product = selected.value;
        const access = await readEffectiveProductAccess(tx, { accountId, product, at: txNow });
        if (!access.ok) return access;
        const allowed = decideStartAccess(access.value, request.channel);
        if (!allowed.ok) return allowed;
        if (replay.value.replayed) {
            const stillOpen = decideStartOpen(product);
            if (!stillOpen.ok) return stillOpen;
            const id = Uint8Array.fromHex(replay.value.result.start);
            const row = await queryOne(
                tx,
                StartRowSchema,
                sql`select s.container_key, s.expires_at, s.consumed_at, r.seal
                    from session_start s
                    join release_seal r on r.product_id = s.product_id and r.channel = s.channel
                                       and r.number = s.release_number
                    where s.id = ${id}`,
            );
            if (!row.ok) return row;
            // An unused start is swept a minute after it expired; its receipt outlives it.
            return decideStartReplay(id, row.value, txNow);
        }

        const channel = allowed.value;

        const loader = await findCurrentRelease(tx, {
            productId: LOADER_PRODUCT,
            channel: LOADER_CHANNEL,
        });
        if (!loader.ok) return loader;
        const current = decideStartLoader(loader.value?.id ?? null, request.loaderRelease);
        if (!current.ok) return current;
        const open = decideStartOpen(product);
        if (!open.ok) return open;
        const foundRelease = await findCurrentRelease(tx, { productId: product.id, channel });
        if (!foundRelease.ok) return foundRelease;
        const release = decideStartRelease(foundRelease.value);
        if (!release.ok) return release;
        const modules = toModulesJson(request.modules);
        const coverage = await lockBuildCoverage(tx, { productId: product.id, mode: "shared" });
        if (!coverage.ok) return coverage;
        const reported = await execute(
            tx,
            sql`insert into game_build_report (product_id, modules, reported_at)
                values (${product.id}, ${modules}::jsonb, ${toTimestamptz(txNow)}::timestamptz)
                on conflict (product_id) do update
                set modules = excluded.modules, reported_at = excluded.reported_at
                where game_build_report.reported_at <= excluded.reported_at`,
        );
        if (!reported.ok) return reported;
        const seen = await recordBuildsSeen(tx, {
            productId: product.id,
            modules: request.modules,
            txNow,
        });
        if (!seen.ok) return seen;
        const covered = await coversCoreFacts(tx, release.value.id, request.modules);
        if (!covered.ok) return covered;
        const support = await recordSupportAfterReport(tx, {
            product,
            channel,
            newlySeen: seen.value,
            covered: covered.value,
            modules: request.modules,
            txNow,
        });
        if (!support.ok) return support;
        // Committed with the report: the builds a refused start brought are what the product page
        // checks, so it says "not yet supported" after a game update.
        const plan = decideStart({ coreFacts: covered.value }, txNow, START_TTL_MS);
        if (!plan.ok) return errCommit(plan.error);

        const inserted = await execute(
            tx,
            sql`insert into session_start
                    (id, account_id, device_id, product_id, channel, release_id, release_number,
                     container_key, created_at, expires_at, modules)
                values (${startId}, ${accountId}, ${device.value.id}, ${product.id}, ${channel},
                        ${release.value.id}, ${release.value.number}, ${containerKey},
                        ${toTimestamptz(txNow)}::timestamptz,
                        ${toTimestamptz(plan.value)}::timestamptz,
                        ${modules}::jsonb)`,
        );
        if (!inserted.ok) return inserted;
        const recorded = await recordReceipt(tx, op, { start: toHex(startId) });
        if (!recorded.ok) return recorded;
        return ok({ start: startId, containerKey, releaseSeal: release.value.seal });
    });
}

// A core capability is checked when every module its facts resolve in (the manifest names each
// fact's) is among the reported builds: then every one of its facts must be in some current set
// for the reported builds. One with a module not reported waits for that module to load, and kit
// refuses then if it stays uncovered. A release with no core capability needs no set at all.
export async function coversCoreFacts(
    q: Queryable,
    releaseId: Uint8Array,
    builds: readonly ModuleKey[],
): Promise<Result<boolean, DbFailure>> {
    const bytes = await findReleaseManifest(q, releaseId);
    if (!bytes.ok) return bytes;
    invariant(bytes.value !== null, "a module release has a manifest");
    const manifest = parseModuleManifest(bytes.value);
    invariant(manifest.ok, "a stored release manifest was verified when it was published");
    const needed = decideNeededFacts(manifest.value, builds);
    if (!needed.ok) return needed;
    if (needed.value.size === 0) return ok(true);
    const covered = await readCoveredFactKeys(q, { releaseId, builds });
    if (!covered.ok) return covered;
    return ok([...needed.value].every((key) => covered.value.has(key)));
}

// The builds a start reported, as session_start.modules and game_build_report.modules store them:
// [name hash, time-date stamp, size of image], the name hash a decimal string, being a u64.
export const StartModules = z
    .array(z.tuple([z.string(), z.number(), z.number()]))
    .transform((builds): ModuleKey[] =>
        builds.map(([nameHash, timeDateStamp, sizeOfImage]) => ({
            nameHash: BigInt(nameHash),
            timeDateStamp,
            sizeOfImage,
        })),
    );

export function toModulesJson(builds: readonly ModuleKey[]): string {
    return JSON.stringify(
        builds.map((build) => [build.nameHash.toString(), build.timeDateStamp, build.sizeOfImage]),
    );
}

// The first report of each build, for update-day latency. A build some release of the product
// already runs a current set for was covered before anyone reported it: its promotion time is the
// earliest still on record, and the latency reads as none. The request's modules are sorted, so
// concurrent starts insert in the same order. Answers how many builds no start had reported.
async function recordBuildsSeen(
    tx: Queryable,
    params: {
        readonly productId: string;
        readonly modules: readonly ModuleKey[];
        readonly txNow: EpochMs;
    },
): Promise<Result<number, DbFailure>> {
    if (params.modules.length === 0) return ok(0);
    const inserted = await execute(
        tx,
        sql`insert into module_build_seen
                (product_id, name_hash, time_date_stamp, size_of_image, first_reported_at,
                 first_covered_at)
            select ${params.productId}, m.name_hash::numeric, m.tds, m.size,
                   ${toTimestamptz(params.txNow)}::timestamptz,
                   (select min(c.promoted_at) from current_fact_set c
                    join release r on r.id = c.release_id
                    where r.product_id = ${params.productId} and c.name_hash = m.name_hash::numeric
                      and c.time_date_stamp = m.tds and c.size_of_image = m.size)
            from jsonb_to_recordset(${JSON.stringify(
                params.modules.map((m) => ({
                    name_hash: m.nameHash.toString(),
                    tds: m.timeDateStamp,
                    size: m.sizeOfImage,
                })),
            )}::jsonb) as m(name_hash text, tds bigint, size bigint)
            on conflict do nothing`,
    );
    if (!inserted.ok) return inserted;
    return ok(inserted.value);
}

export type StartContainer = {
    readonly key: Uint8Array;
    readonly container: Uint8Array;
};

// The start's container for its own device to download, until the session consumes the start. A
// suspension or revocation since the start stops the download too; read without locks, since
// nothing here is written.
export async function readStartContainer(
    db: Db,
    params: {
        readonly holder: TokenHolder;
        readonly proof: DpopProof;
        readonly startId: Uint8Array;
        readonly catalog: ProductCatalog;
    },
): Promise<
    Result<
        StartContainer,
        Code<"NOT_FOUND" | "START_EXPIRED" | "ACCOUNT_SUSPENDED" | "DEVICE_REVOKED"> | DbFailure
    >
> {
    return await withTx(db, async (tx, txNow) => {
        const row = await queryOne(
            tx,
            z.object({
                account_active: z.boolean(),
                product_id: z.string(),
                device_revoked: z.boolean(),
                container_key: z.instanceof(Uint8Array).nullable(),
                expires_at: EpochMs,
                consumed_at: EpochMs.nullable(),
                container: z.instanceof(Uint8Array).nullable(),
            }),
            sql`select a.status = 'active' and not a.is_locked and a.deleted_at is null
                           as account_active,
                       d.revoked_at is not null as device_revoked,
                       s.product_id, s.container_key, s.expires_at, s.consumed_at, r.container
                from session_start s
                join account a on a.id = s.account_id
                join device d on d.id = s.device_id
                join release r on r.id = s.release_id
                where s.id = ${params.startId} and s.account_id = ${params.holder.accountId}
                  and d.jkt = ${params.proof.jkt}`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err({ code: "NOT_FOUND" });
        const start = row.value;
        if (!start.account_active) return err({ code: "ACCOUNT_SUSPENDED" });
        if (start.device_revoked) return err({ code: "DEVICE_REVOKED" });
        if (!decideStartStillOpen(params.catalog, start.product_id).ok)
            return err({ code: "START_EXPIRED" });
        if (
            start.consumed_at !== null ||
            start.expires_at <= txNow ||
            start.container_key === null
        ) {
            return err({ code: "START_EXPIRED" });
        }
        invariant(start.container !== null, "a start's release has a container");
        return ok({ key: start.container_key, container: start.container });
    });
}
