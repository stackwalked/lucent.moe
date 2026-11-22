import type { ModuleKey } from "@lucent/bundle/fact-set";
import { parseReleaseManifestV3 } from "@lucent/bundle/release-manifest";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import { ChannelId, EpochMs, type OperationId, ProductId, toHex } from "@lucent/core/scalars";
import { CONTAINER_KEY_SIZE, type StartReply, type StartRequest } from "@lucent/wire/start";
import { z } from "zod";
import { readEffectiveProductAccess } from "../authority/entitlements.ts";
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
import { type AccountInactive, lockActiveAccount } from "./accounts.ts";
import { findDeviceByKey, lockDevice } from "./devices.ts";
import type { DpopProof } from "./dpop.ts";
import { readCoveredFactKeys } from "./fact-sets.ts";
import { newWireId } from "./ids.ts";
import {
    findCurrentRelease,
    findReleaseManifest,
    LOADER_CHANNEL,
    LOADER_PRODUCT,
} from "./releases.ts";
import type { TokenHolder } from "./sign-in.ts";

// A start is the server's yes to running a module: every check in one transaction, then the
// release seal and a fresh key that opens this start's copy of the container. The module's hello
// consumes it; unused, it expires after a minute.

export const START_TTL_MS = 60 * 1_000;

type Code<C extends string> = { readonly code: C };

export type StartRefusal =
    | AccountInactive
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
// entitled to, then whether the loader and the release are current. The slot never refuses (the
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
        const account = await lockActiveAccount(tx, accountId, txNow);
        if (!account.ok) return account;
        const found = await findDeviceByKey(tx, { accountId, jkt: params.proof.jkt });
        if (!found.ok) return found;
        if (found.value === null || found.value.revokedAt !== null) {
            return err({ code: "DEVICE_REVOKED" });
        }
        const device = await lockDevice(tx, found.value.id);
        if (!device.ok) return device;
        if (device.value.revokedAt !== null) return err({ code: "DEVICE_REVOKED" });

        const replay = await readReplay(tx, op, StartReceipt);
        if (!replay.ok) return replay;
        if (replay.value.replayed) {
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
            const start = row.value;
            if (
                start === null ||
                start.consumed_at !== null ||
                start.expires_at <= txNow ||
                start.container_key === null
            ) {
                return err({ code: "START_EXPIRED" });
            }
            return ok({ start: id, containerKey: start.container_key, releaseSeal: start.seal });
        }

        const productId = ProductId.safeParse(request.product);
        const product = productId.success ? params.catalog.get(productId.data) : undefined;
        if (product === undefined || product.kind !== "module") return err({ code: "NOT_FOUND" });
        const access = await readEffectiveProductAccess(tx, { accountId, product, at: txNow });
        if (!access.ok) return access;
        if (!access.value.isEntitled) return err({ code: "ENTITLEMENT_INACTIVE" });
        const channel = ChannelId.parse(request.channel);
        if (!access.value.channels.includes(channel)) return err({ code: "CHANNEL_NOT_ALLOWED" });

        const loader = await findCurrentRelease(tx, {
            productId: LOADER_PRODUCT,
            channel: LOADER_CHANNEL,
        });
        if (!loader.ok) return loader;
        if (loader.value === null) return err({ code: "RELEASE_UNAVAILABLE" });
        if (toHex(loader.value.id) !== toHex(request.loaderRelease)) {
            return err({ code: "LOADER_UPDATE_REQUIRED" });
        }
        const release = await findCurrentRelease(tx, { productId: product.id, channel });
        if (!release.ok) return release;
        if (release.value === null) return err({ code: "RELEASE_UNAVAILABLE" });
        invariant(release.value.hasContainer, "a module product's current release has a container");
        const modules = toModulesJson(request.modules);
        const reported = await execute(
            tx,
            sql`insert into game_build_report (product_id, modules, reported_at)
                values (${product.id}, ${modules}::jsonb, ${toTimestamptz(txNow)}::timestamptz)
                on conflict (product_id) do update
                set modules = excluded.modules, reported_at = excluded.reported_at
                where game_build_report.reported_at <= excluded.reported_at`,
        );
        if (!reported.ok) return reported;
        const covered = await coversCoreFacts(tx, release.value.id, request.modules);
        if (!covered.ok) return covered;
        // Committed with the report: the builds a refused start brought are what the product page
        // checks, so it says "not yet supported" after a game update.
        if (!covered.value) return errCommit({ code: "GAME_BUILD_UNSUPPORTED" as const });

        const inserted = await execute(
            tx,
            sql`insert into session_start
                    (id, account_id, device_id, product_id, channel, release_id, release_number,
                     container_key, created_at, expires_at, modules)
                values (${startId}, ${accountId}, ${device.value.id}, ${product.id}, ${channel},
                        ${release.value.id}, ${release.value.number}, ${containerKey},
                        ${toTimestamptz(txNow)}::timestamptz,
                        ${toTimestamptz(EpochMs.parse(txNow + START_TTL_MS))}::timestamptz,
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
    const manifest = parseReleaseManifestV3(bytes.value);
    invariant(manifest.ok, "a stored release manifest was verified when it was published");
    const moduleOf = new Map(manifest.value.facts.map((fact) => [fact.key, fact.module]));
    const reported = new Set(builds.map((build) => build.nameHash));
    const needed = new Set<bigint>();
    for (const capability of manifest.value.capabilities) {
        const modules = capability.members.map((member) => moduleOf.get(member));
        invariant(!modules.includes(undefined), "a capability's members are among the facts");
        if (
            capability.level === "core" &&
            modules.every((m) => m !== undefined && reported.has(m))
        ) {
            for (const member of capability.members) needed.add(member);
        }
    }
    if (needed.size === 0) return ok(true);
    const covered = await readCoveredFactKeys(q, { releaseId, builds });
    if (!covered.ok) return covered;
    return ok([...needed].every((key) => covered.value.has(key)));
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

function toModulesJson(builds: readonly ModuleKey[]): string {
    return JSON.stringify(
        builds.map((build) => [build.nameHash.toString(), build.timeDateStamp, build.sizeOfImage]),
    );
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
                device_revoked: z.boolean(),
                container_key: z.instanceof(Uint8Array).nullable(),
                expires_at: EpochMs,
                consumed_at: EpochMs.nullable(),
                container: z.instanceof(Uint8Array).nullable(),
            }),
            sql`select a.status = 'active' and not a.is_locked as account_active,
                       d.revoked_at is not null as device_revoked,
                       s.container_key, s.expires_at, s.consumed_at, r.container
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
