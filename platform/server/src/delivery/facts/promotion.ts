import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, toHex } from "@lucent/core/scalars";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    queryAll,
    queryOne,
    sql,
    toTimestamptz,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { type Forbidden, lockAuthorized, readAsStaff } from "../../identity/authority/staff.ts";
import { recordSupportAfterFactPromotion } from "../../members/record/support.ts";
import { bumpDataRevisions } from "../runtime/revisions.ts";
import { lockBuildCoverage } from "./coverage-lock.ts";

// Promotion of staged fact sets (publishing.ts stores them). One current revision per
// release and module build; promoting a set makes it current for every build it lists, and a set
// whose revision is below the current one of any of them is refused: a bad revision is fixed by
// the next one. A promotion reaches the next session at its start, and a running session on one of
// the builds at its next lease, whose data revision rises.

// A module build as staff read it: the name hash as 16 hex digits, the rest as numbers.
export type BuildKey = {
    readonly nameHash: string;
    readonly timeDateStamp: number;
    readonly sizeOfImage: number;
};

export type StagedFactSet = {
    readonly setId: string;
    readonly revision: number;
    readonly stagedAt: EpochMs;
    readonly builds: readonly BuildKey[];
};

export type ReleaseFactSets = {
    readonly releaseId: string;
    readonly productId: string;
    readonly channel: string;
    // Every build the release has a set for, with the set current for it (null: none promoted).
    readonly builds: readonly {
        readonly build: BuildKey;
        readonly current: {
            readonly setId: string;
            readonly revision: number;
            readonly promotedAt: EpochMs;
        } | null;
    }[];
    // The newest sets first, at most SET_LIMIT of them.
    readonly sets: readonly StagedFactSet[];
};

const SET_LIMIT = 50;

const BuildRow = z.object({
    name_hash: z.string(),
    time_date_stamp: z.coerce.number(),
    size_of_image: z.coerce.number(),
});

function toBuildKey(row: z.output<typeof BuildRow>): BuildKey {
    return {
        nameHash: BigInt(row.name_hash).toString(16).padStart(16, "0"),
        timeDateStamp: row.time_date_stamp,
        sizeOfImage: row.size_of_image,
    };
}

function buildOf(key: BuildKey): string {
    return `${key.nameHash}:${key.timeDateStamp}:${key.sizeOfImage}`;
}

// A module release's sets; NOT_FOUND for a release that doesn't exist or carries no facts (the
// loader's).
export async function listReleaseFactSets(
    db: Db,
    params: { readonly caller: Caller; readonly releaseId: Uint8Array },
): Promise<Result<ReleaseFactSets, Forbidden | { readonly code: "NOT_FOUND" } | DbFailure>> {
    const actions = ["facts:promote", "releases:promote"] as const;
    type Read = Result<ReleaseFactSets, { readonly code: "NOT_FOUND" } | DbFailure>;
    return await readAsStaff(db, { caller: params.caller, actions }, async (q): Promise<Read> => {
        const release = await queryOne(
            q,
            z.object({ product_id: z.string(), channel: z.string() }),
            sql`select product_id, channel from release
                where id = ${params.releaseId} and manifest is not null`,
        );
        if (!release.ok) return release;
        if (release.value === null) return err({ code: "NOT_FOUND" as const });
        const sets = await queryAll(
            q,
            BuildRow.extend({
                set_id: z.string(),
                revision: z.coerce.number(),
                created_at: EpochMs,
            }),
            sql`select s.id::text as set_id, b.revision, s.created_at, b.name_hash::text as name_hash,
                       b.time_date_stamp, b.size_of_image
                from (select id, created_at from fact_set where release_id = ${params.releaseId}
                      order by id desc limit ${SET_LIMIT}) s
                join fact_set_build b on b.set_id = s.id
                order by s.id desc, b.name_hash, b.time_date_stamp, b.size_of_image`,
        );
        if (!sets.ok) return sets;
        const builds = await queryAll(
            q,
            BuildRow.extend({
                set_id: z.string().nullable(),
                revision: z.coerce.number().nullable(),
                promoted_at: EpochMs.nullable(),
            }),
            sql`select distinct on (b.name_hash, b.time_date_stamp, b.size_of_image)
                       b.name_hash::text as name_hash, b.time_date_stamp, b.size_of_image,
                       cb.set_id::text as set_id, c.revision, c.promoted_at
                from fact_set_build b
                left join current_fact_set c
                  on c.release_id = b.release_id and c.name_hash = b.name_hash
                 and c.time_date_stamp = b.time_date_stamp and c.size_of_image = b.size_of_image
                left join fact_set_build cb
                  on cb.release_id = c.release_id and cb.name_hash = c.name_hash
                 and cb.time_date_stamp = c.time_date_stamp and cb.size_of_image = c.size_of_image
                 and cb.revision = c.revision
                where b.release_id = ${params.releaseId}
                order by b.name_hash, b.time_date_stamp, b.size_of_image`,
        );
        if (!builds.ok) return builds;

        const staged: StagedFactSet[] = [];
        for (const row of sets.value) {
            const last = staged.at(-1);
            if (last?.setId === row.set_id) {
                staged[staged.length - 1] = { ...last, builds: [...last.builds, toBuildKey(row)] };
                continue;
            }
            staged.push({
                setId: row.set_id,
                revision: row.revision,
                stagedAt: row.created_at,
                builds: [toBuildKey(row)],
            });
        }
        return ok({
            releaseId: toHex(params.releaseId),
            productId: release.value.product_id,
            channel: release.value.channel,
            builds: builds.value.map((row) => ({
                build: toBuildKey(row),
                current:
                    row.set_id === null || row.revision === null || row.promoted_at === null
                        ? null
                        : {
                              setId: row.set_id,
                              revision: row.revision,
                              promotedAt: row.promoted_at,
                          },
            })),
            sets: staged,
        });
    });
}

export type PromoteFactSetRefusal =
    | AuthzRefusal
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "REVISION_BELOW_CURRENT"; readonly current: number };

// Promoting a set already current for every build it lists changes nothing and records nothing.
export async function promoteFactSet(
    db: Db,
    params: { readonly caller: Caller; readonly releaseId: Uint8Array; readonly setId: string },
): Promise<Result<{ readonly changed: boolean }, PromoteFactSetRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: "facts:promote",
            txNow,
        });
        if (!authorized.ok) return authorized;
        // The lock `ops publish-fact-set` takes for the release: a promotion and a publish of the
        // same release never interleave, nor do two promotions.
        const locked = await execute(
            tx,
            sql`select pg_advisory_xact_lock(hashtextextended(
                    ${`lucent.fact-set:${toHex(params.releaseId)}`}, 0))`,
        );
        if (!locked.ok) return locked;
        const release = await queryOne(
            tx,
            z.object({ product_id: z.string() }),
            sql`select product_id from release where id = ${params.releaseId}`,
        );
        if (!release.ok) return release;
        if (release.value === null) return err({ code: "NOT_FOUND" as const });
        const coverage = await lockBuildCoverage(tx, {
            productId: release.value.product_id,
            mode: "exclusive",
        });
        if (!coverage.ok) return coverage;
        const listed = await queryAll(
            tx,
            BuildRow.extend({ revision: z.coerce.number(), current: z.coerce.number().nullable() }),
            sql`select b.name_hash::text as name_hash, b.time_date_stamp, b.size_of_image,
                       b.revision, c.revision as current
                from fact_set_build b
                left join current_fact_set c
                  on c.release_id = b.release_id and c.name_hash = b.name_hash
                 and c.time_date_stamp = b.time_date_stamp and c.size_of_image = b.size_of_image
                where b.set_id = ${params.setId}::bigint and b.release_id = ${params.releaseId}
                order by b.name_hash, b.time_date_stamp, b.size_of_image`,
        );
        if (!listed.ok) return listed;
        const [first] = listed.value;
        if (first === undefined) return err({ code: "NOT_FOUND" as const });
        const { revision } = first;
        const above = listed.value.find((row) => row.current !== null && row.current > revision);
        if (above !== undefined && above.current !== null) {
            return err({ code: "REVISION_BELOW_CURRENT" as const, current: above.current });
        }
        const moving = listed.value.filter((row) => row.current !== revision);
        if (moving.length === 0) return ok({ changed: false });
        for (const row of moving) {
            const promoted = await execute(
                tx,
                sql`insert into current_fact_set
                        (release_id, name_hash, time_date_stamp, size_of_image, revision,
                         promoted_at)
                    values (${params.releaseId}, ${row.name_hash}::numeric, ${row.time_date_stamp},
                            ${row.size_of_image}, ${revision}, ${toTimestamptz(txNow)}::timestamptz)
                    on conflict (release_id, name_hash, time_date_stamp, size_of_image)
                    do update set revision = excluded.revision, promoted_at = excluded.promoted_at`,
            );
            if (!promoted.ok) return promoted;
        }
        const covered = await execute(
            tx,
            sql`update module_build_seen b set first_covered_at = ${toTimestamptz(txNow)}::timestamptz
                from release r,
                     jsonb_to_recordset(${JSON.stringify(moving)}::jsonb)
                         as m(name_hash text, time_date_stamp bigint, size_of_image bigint)
                where r.id = ${params.releaseId} and b.product_id = r.product_id
                  and b.name_hash = m.name_hash::numeric and b.time_date_stamp = m.time_date_stamp
                  and b.size_of_image = m.size_of_image and b.first_covered_at is null`,
        );
        if (!covered.ok) return covered;
        const support = await recordSupportAfterFactPromotion(tx, {
            productId: release.value.product_id,
            txNow,
        });
        if (!support.ok) return support;
        const bumped = await bumpDataRevisions(tx, {
            releaseId: params.releaseId,
            change: {
                kind: "promotion",
                builds: moving.map((row) => ({
                    nameHash: BigInt(row.name_hash),
                    timeDateStamp: row.time_date_stamp,
                    sizeOfImage: row.size_of_image,
                })),
            },
        });
        if (!bumped.ok) return bumped;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "fact_set.promote",
            target: {
                releaseId: toHex(params.releaseId),
                setId: params.setId,
                revision,
                builds: listed.value.map((row) => ({
                    build: buildOf(toBuildKey(row)),
                    previous: row.current,
                })),
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ changed: true });
    });
}
