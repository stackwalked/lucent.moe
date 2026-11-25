import { type DeliveredSet, parseBundle, toBundleBytes, verifySet } from "@lucent/bundle/bundle";
import type { ModuleKey } from "@lucent/bundle/fact-set";
import {
    coreFactKeysIn,
    manifestDigest,
    parseModuleManifest,
} from "@lucent/bundle/release-manifest";
import { equalBytes } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { toHex } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryAll,
    queryOne,
    sql,
    type Tx,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { findReleaseManifest } from "../releases/reads.ts";

// `ops publish-fact-set`: a set enters staged, verified against the offline facts key, signed for
// this release's manifest, carrying every core fact that resolves in a module build it lists, and
// at a revision above every one stored for the release and each module build it lists. Promotion
// (current_fact_set) isn't written here. Nothing here signs: a taken-over server can withhold
// facts, never forge one.

// Why 512 KiB: a data_response answers with every applicable set whole, and the frame it rides in
// holds 1 MiB of plaintext (MAX_FRAME_PLAIN_SIZE). Two sets at the cap, one for the start's build
// and one spanning it and a late build, fit with headroom for the response's own fields; a set
// above it could make a delivery that no frame can carry.
export const MAX_FACT_SET_BYTES = 512 * 1024;

export type FactSetRefusal =
    | { readonly code: "FACT_SET_INVALID" }
    | { readonly code: "FACT_SET_TOO_LARGE" }
    | { readonly code: "FACT_SET_UNSIGNED" }
    | { readonly code: "RELEASE_NOT_FOUND" }
    | { readonly code: "MANIFEST_DIGEST_MISMATCH" }
    | { readonly code: "CORE_FACT_MISSING"; readonly key: string }
    | { readonly code: "REVISION_NOT_ABOVE"; readonly highest: number };

export type PublishedFactSet = {
    readonly release: Uint8Array;
    readonly revision: number;
    readonly modules: readonly ModuleKey[];
};

const FACT_KEY_SIZE = 8;

// A published set file is a fact bundle (contracts/fact-bundle/v1) of exactly one set that
// delivers every entry, as the generator writes it.
export async function publishFactSet(
    db: Db,
    params: {
        readonly factsKeys: readonly Uint8Array[];
        readonly releaseId: Uint8Array;
        readonly bundle: Uint8Array;
    },
): Promise<Result<PublishedFactSet, FactSetRefusal | DbFailure>> {
    if (params.bundle.byteLength > MAX_FACT_SET_BYTES) return err({ code: "FACT_SET_TOO_LARGE" });
    const parsed = parseBundle(params.bundle);
    if (!parsed.ok || parsed.value.length !== 1) return err({ code: "FACT_SET_INVALID" });
    const [set] = parsed.value;
    invariant(set !== undefined, "a bundle of one set has one");
    const { header } = set;
    const isComplete =
        set.entries.length === header.entryCount &&
        set.entries.every((given, index) => given.index === index);
    if (!isComplete) return err({ code: "FACT_SET_INVALID" });
    const verified = await verifySet(set, params.factsKeys);
    if (!verified.ok) {
        return err({
            code: verified.error.code === "UNPROVEN" ? "FACT_SET_INVALID" : "FACT_SET_UNSIGNED",
        });
    }

    const manifestBytes = await findReleaseManifest(db, params.releaseId);
    if (!manifestBytes.ok) return manifestBytes;
    if (manifestBytes.value === null) return err({ code: "RELEASE_NOT_FOUND" });
    const manifest = parseModuleManifest(manifestBytes.value);
    invariant(manifest.ok, "a stored release manifest was verified when it was published");
    if (!equalBytes(header.manifestDigest, manifestDigest(manifest.value.facts))) {
        return err({ code: "MANIFEST_DIGEST_MISMATCH" });
    }
    const present = new Set(set.entries.map((given) => given.entry.key));
    // A set is per module build: it owes the core facts of the modules it lists, and no others.
    const owed = header.modules.flatMap((module) =>
        coreFactKeysIn(manifest.value, module.nameHash),
    );
    const missing = owed.find((key) => !present.has(key));
    if (missing !== undefined) {
        return err({ code: "CORE_FACT_MISSING", key: missing.toString(16).padStart(16, "0") });
    }

    const keys = new Uint8Array(set.entries.length * FACT_KEY_SIZE);
    const view = new DataView(keys.buffer);
    set.entries.forEach((given, index) => {
        view.setBigUint64(index * FACT_KEY_SIZE, given.entry.key, true);
    });
    return await withTx(db, async (tx) => {
        const locked = await execute(
            tx,
            sql`select pg_advisory_xact_lock(hashtextextended(
                    ${`lucent.fact-set:${toHex(params.releaseId)}`}, 0))`,
        );
        if (!locked.ok) return locked;
        const highest = await highestRevision(tx, params.releaseId, header.modules);
        if (!highest.ok) return highest;
        if (highest.value !== null && header.revision <= highest.value) {
            return err({ code: "REVISION_NOT_ABOVE", highest: highest.value });
        }
        const inserted = await queryOne(
            tx,
            z.object({ id: z.string() }),
            sql`insert into fact_set (release_id, bundle, fact_keys)
                values (${params.releaseId}, ${params.bundle}, ${keys})
                returning id::text as id`,
        );
        if (!inserted.ok) return inserted;
        invariant(inserted.value !== null, "an insert returns its row");
        for (const module of header.modules) {
            const indexed = await execute(
                tx,
                sql`insert into fact_set_build
                        (set_id, release_id, name_hash, time_date_stamp, size_of_image, revision)
                    values (${inserted.value.id}::bigint, ${params.releaseId},
                            ${module.nameHash.toString()}::numeric, ${module.timeDateStamp},
                            ${module.sizeOfImage}, ${header.revision})`,
            );
            if (!indexed.ok) return indexed;
        }
        return ok({
            release: params.releaseId,
            revision: header.revision,
            modules: header.modules,
        });
    });
}

// The highest revision stored for the release under any of the builds; null when none. Read under
// the release's advisory lock, so two publishes can't both take the next revision.
async function highestRevision(
    tx: Tx,
    releaseId: Uint8Array,
    builds: readonly ModuleKey[],
): Promise<Result<number | null, DbFailure>> {
    let highest: number | null = null;
    for (const build of builds) {
        const row = await queryOne(
            tx,
            z.object({ highest: z.coerce.number().nullable() }),
            sql`select max(revision) as highest from fact_set_build
                where release_id = ${releaseId} and name_hash = ${build.nameHash.toString()}::numeric
                  and time_date_stamp = ${build.timeDateStamp}
                  and size_of_image = ${build.sizeOfImage}`,
        );
        if (!row.ok) return row;
        const found = row.value?.highest ?? null;
        if (found !== null && (highest === null || found > highest)) highest = found;
    }
    return ok(highest);
}

type BuildsAsked = {
    readonly releaseId: Uint8Array;
    // The builds asked about: each one's current set is looked up.
    readonly builds: readonly ModuleKey[];
    // Builds already loaded that count when judging whether a set applies, though nothing is asked
    // about them: a late request's session start's builds.
    readonly loaded?: readonly ModuleKey[];
};

// The release's current sets that apply to the asked builds. A set applies when it is the current
// set of some asked build and every build it lists is asked or loaded: a module applies a set only
// when everything that shaped it is loaded, and a late build's set may span builds the start
// already reported. `unsupported` is every asked build whose own current set doesn't apply (or that
// has none). Sets are in the order of the builds that found them, each once.
async function readApplicableSets(
    q: Queryable,
    params: BuildsAsked,
): Promise<Result<{ setIds: string[]; unsupported: ModuleKey[] }, DbFailure>> {
    if (params.builds.length === 0) return ok({ setIds: [], unsupported: [] });
    const reported = new Set([...params.builds, ...(params.loaded ?? [])].map(buildId));
    // One query for every asked build's current set, in the order asked, and one for what those
    // sets list: a start reports up to 64 builds, and the product page asks per channel.
    const current = await queryAll(
        q,
        z.object({ set_id: z.string().nullable() }),
        sql`select b.set_id::text as set_id
            from unnest(${params.builds.map((build) => build.nameHash.toString())}::numeric[],
                        ${params.builds.map((build) => build.timeDateStamp)}::bigint[],
                        ${params.builds.map((build) => build.sizeOfImage)}::bigint[])
                 with ordinality as a(name_hash, time_date_stamp, size_of_image, ordinal)
            left join current_fact_set c
              on c.release_id = ${params.releaseId} and c.name_hash = a.name_hash
             and c.time_date_stamp = a.time_date_stamp and c.size_of_image = a.size_of_image
            left join fact_set_build b
              on b.release_id = c.release_id and b.name_hash = c.name_hash
             and b.time_date_stamp = c.time_date_stamp and b.size_of_image = c.size_of_image
             and b.revision = c.revision
            order by a.ordinal`,
    );
    if (!current.ok) return current;
    invariant(current.value.length === params.builds.length, "one row per asked build");
    const found = [...new Set(current.value.flatMap((row) => row.set_id ?? []))];
    const listed = await queryAll(
        q,
        z.object({
            set_id: z.string(),
            name_hash: z.string(),
            time_date_stamp: z.coerce.number(),
            size: z.coerce.number(),
        }),
        sql`select set_id::text as set_id, name_hash::text as name_hash, time_date_stamp,
                   size_of_image as size
            from fact_set_build where set_id = any(${found}::bigint[])`,
    );
    if (!listed.ok) return listed;
    const applies = new Map(found.map((setId) => [setId, true]));
    for (const row of listed.value) {
        const isReported = reported.has(
            buildId({
                nameHash: BigInt(row.name_hash),
                timeDateStamp: row.time_date_stamp,
                sizeOfImage: row.size,
            }),
        );
        if (!isReported) applies.set(row.set_id, false);
    }
    const setIds: string[] = [];
    const unsupported: ModuleKey[] = [];
    params.builds.forEach((build, index) => {
        const setId = current.value[index]?.set_id ?? null;
        if (setId === null || applies.get(setId) !== true) {
            unsupported.push(build);
            return;
        }
        if (!setIds.includes(setId)) setIds.push(setId);
    });
    return ok({ setIds, unsupported });
}

// The facts the release's current sets hold for the reported builds (see readApplicableSets); a
// start asks nothing of builds beyond the ones it reports.
export async function readCoveredFactKeys(
    q: Queryable,
    params: { readonly releaseId: Uint8Array; readonly builds: readonly ModuleKey[] },
): Promise<Result<Set<bigint>, DbFailure>> {
    const found = await readApplicableSets(q, params);
    if (!found.ok) return found;
    const covered = new Set<bigint>();
    for (const setId of found.value.setIds) {
        const keys = await queryOne(
            q,
            z.object({ fact_keys: z.instanceof(Uint8Array) }),
            sql`select fact_keys from fact_set where id = ${setId}::bigint`,
        );
        if (!keys.ok) return keys;
        invariant(keys.value !== null, "a set indexed by a build exists");
        const bytes = keys.value.fact_keys;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let at = 0; at < bytes.byteLength; at += FACT_KEY_SIZE) {
            covered.add(view.getBigUint64(at, true));
        }
    }
    return ok(covered);
}

// What the data route delivers for the builds: the applicable sets, each whole, as one fact bundle
// (contracts/fact-bundle/v1), and the builds nothing applies to.
export type FactDelivery = {
    readonly bundle: Uint8Array<ArrayBuffer>;
    readonly unsupported: readonly ModuleKey[];
};

export async function readFactDelivery(
    q: Queryable,
    params: BuildsAsked,
): Promise<Result<FactDelivery, DbFailure>> {
    const found = await readApplicableSets(q, params);
    if (!found.ok) return found;
    const sets: DeliveredSet[] = [];
    for (const setId of found.value.setIds) {
        const row = await queryOne(
            q,
            z.object({ bundle: z.instanceof(Uint8Array) }),
            sql`select bundle from fact_set where id = ${setId}::bigint`,
        );
        if (!row.ok) return row;
        invariant(row.value !== null, "a set indexed by a build exists");
        const parsed = parseBundle(row.value.bundle);
        invariant(
            parsed.ok && parsed.value.length === 1,
            "a stored set is a bundle of one, checked when published",
        );
        const [set] = parsed.value;
        invariant(set !== undefined, "a bundle of one set has one");
        sets.push(set);
    }
    return ok({ bundle: toBundleBytes(sets), unsupported: found.value.unsupported });
}

function buildId(build: ModuleKey): string {
    return `${build.nameHash}:${build.timeDateStamp}:${build.sizeOfImage}`;
}

// What ops prints for a published fact set.
export function describePublishedFactSet(published: PublishedFactSet): Record<string, unknown> {
    return {
        release: toHex(published.release),
        revision: published.revision,
        modules: published.modules.map((module) => ({
            nameHash: module.nameHash.toString(16).padStart(16, "0"),
            timeDateStamp: module.timeDateStamp,
            sizeOfImage: module.sizeOfImage,
        })),
    };
}
