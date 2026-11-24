import { ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import type { CountryLookup, Geo } from "../adapters/geo/geo.ts";
import {
    type Db,
    type DbFailure,
    execute,
    queryAll,
    queryOne,
    sql,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import type { Job } from "../jobs/runner.ts";
import { appendSignals } from "../risk/signals.ts";
import { decideSignInCountry, decideUnjudgedCutoff } from "./sign-in-countries.rules.ts";

// Member sign-ins, observed as their sessions are created (migration 0020's trigger), judged by
// country: a new one becomes a `new_country` risk signal, which the scoring job weighs into the
// review queue like any other. Each observation is deleted once judged; the address goes with it.

const COUNTRIES_EVERY_MS = 60 * 1_000;
const RELOAD_EVERY_MS = 10 * 60 * 1_000;
const BATCH = 500;

const ObservationRow = z.object({
    id: z.string(),
    account_id: AccountId,
    ip: z.string(),
    observed_at: EpochMs,
});

export type CountryRun = { readonly judged: number; readonly flagged: number };

// One transaction per sign-in, the account locked first. The signal is stamped with when it was
// judged, not when the sign-in happened, so scoring (which reads a few minutes back from where
// it stopped) can't have passed it already.
async function judge(
    db: Db,
    lookup: CountryLookup,
    row: z.output<typeof ObservationRow>,
): Promise<Result<boolean, DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const locked = await queryOne(
            tx,
            z.object({ id: AccountId }),
            sql`select id from account where id = ${row.account_id} for update`,
        );
        if (!locked.ok) return locked;
        const known = await queryAll(
            tx,
            z.object({ country: z.string() }),
            sql`select country from sign_in_country where account_id = ${row.account_id}`,
        );
        if (!known.ok) return known;
        const plan = decideSignInCountry({
            known: known.value.map((k) => k.country),
            country: lookup(row.ip),
        });
        if (!plan.ok) return plan;
        const seenAt = toTimestamptz(row.observed_at);
        if (plan.value.record !== null) {
            const noted = await execute(
                tx,
                sql`insert into sign_in_country (account_id, country, first_seen_at, last_seen_at)
                    values (${row.account_id}, ${plan.value.record}, ${seenAt}::timestamptz,
                            ${seenAt}::timestamptz)
                    on conflict (account_id, country) do update
                    set last_seen_at = greatest(sign_in_country.last_seen_at, excluded.last_seen_at)`,
            );
            if (!noted.ok) return noted;
        }
        const judged = await execute(
            tx,
            sql`delete from sign_in_observation where id = ${row.id}::bigint`,
        );
        if (!judged.ok) return judged;
        if (plan.value.newCountry) {
            const signalled = await appendSignals(tx, {
                accountId: row.account_id,
                releaseId: null,
                sessionId: null,
                kinds: ["new_country"],
                at: txNow,
            });
            if (!signalled.ok) return signalled;
        }
        return ok(plan.value.newCountry);
    });
}

export async function judgeSignInCountries(
    db: Db,
    lookup: CountryLookup | null,
): Promise<Result<CountryRun, DbFailure>> {
    if (lookup === null) {
        const dropped = await withTx(db, async (tx, txNow) => {
            const cutoff = decideUnjudgedCutoff(txNow);
            if (!cutoff.ok) return cutoff;
            return await execute(
                tx,
                sql`delete from sign_in_observation
                    where observed_at < ${toTimestamptz(cutoff.value)}::timestamptz`,
            );
        });
        return dropped.ok ? ok({ judged: 0, flagged: 0 }) : dropped;
    }
    const rows = await queryAll(
        db,
        ObservationRow,
        sql`select id::text as id, account_id, host(client_ip) as ip, observed_at
            from sign_in_observation order by id limit ${BATCH}`,
    );
    if (!rows.ok) return rows;
    let flagged = 0;
    for (const row of rows.value) {
        const judged = await judge(db, lookup, row);
        if (!judged.ok) return judged;
        if (judged.value) flagged += 1;
    }
    return ok({ judged: rows.value.length, flagged });
}

export function signInCountriesJob(db: Db, geo: Geo | null): Job {
    return {
        name: "sign-in-countries",
        everyMs: COUNTRIES_EVERY_MS,
        run: async () => {
            const run = await judgeSignInCountries(db, geo?.lookup() ?? null);
            if (!run.ok) return run;
            return ok(
                run.value.flagged === 0
                    ? null
                    : `${run.value.flagged} of ${run.value.judged} sign-ins from a new country`,
            );
        },
    };
}

// Picks up a new DB-IP file dropped in place; a broken one leaves the last good file in use.
export function geoReloadJob(geo: Geo): Job {
    return {
        name: "geo-reload",
        everyMs: RELOAD_EVERY_MS,
        run: async () => {
            const reloaded = await geo.reload();
            if (!reloaded.ok) return reloaded;
            return ok(reloaded.value === "loaded" ? "country file loaded" : null);
        },
    };
}
