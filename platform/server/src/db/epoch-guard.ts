import { z } from "zod";
import { err, ok, type Result } from "../core/result.ts";
import { ServiceEpoch } from "../core/scalars.ts";
import { type Db, type DbFailure, type Queryable, queryOne, sql } from "./pool.ts";

const EpochRowSchema = z.object({
    epoch: z.coerce.number().pipe(ServiceEpoch),
});

export async function readServiceEpoch(q: Queryable): Promise<Result<ServiceEpoch, DbFailure>> {
    const rowRes = await queryOne(
        q,
        EpochRowSchema,
        sql`select epoch from service where id = true`,
    );
    if (!rowRes.ok) return rowRes;
    if (rowRes.value === null) {
        return err({ code: "DB_UNAVAILABLE", detail: "service singleton row is missing" });
    }
    return ok(rowRes.value.epoch);
}

export type EpochGuard = {
    readonly initialEpoch: ServiceEpoch;
    readonly isSuperseded: () => boolean;
    readonly checkNow: () => Promise<boolean>;
    readonly close: () => void;
};

// A failed read leaves the process serving and is reported, never treated as supersession:
// superseded is permanent, so failing closed would turn one database blip into an outage that
// lasts until restart. While the database is unreachable, requests fail on their own queries.
export async function openEpochGuard(params: {
    readonly db: Db;
    readonly pollIntervalMs: number;
    readonly onReadFailure: (failure: DbFailure) => void;
}): Promise<Result<EpochGuard, DbFailure>> {
    const initialRes = await readServiceEpoch(params.db);
    if (!initialRes.ok) return initialRes;
    const initialEpoch = initialRes.value;
    let superseded = false;

    const checkNow = async (): Promise<boolean> => {
        if (superseded) return true;
        const current = await readServiceEpoch(params.db);
        if (!current.ok) {
            params.onReadFailure(current.error);
            return false;
        }
        if (current.value !== initialEpoch) {
            superseded = true;
        }
        return superseded;
    };

    const timer = setInterval(() => {
        void checkNow();
    }, params.pollIntervalMs);
    timer.unref();

    return ok({
        initialEpoch,
        isSuperseded: () => superseded,
        checkNow,
        close: () => clearInterval(timer),
    });
}
