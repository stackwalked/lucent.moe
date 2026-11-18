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

// A booting instance takes the next epoch; every instance holding an older one is superseded from
// then on. Reading the epoch instead of taking one would let two instances that boot together
// both believe they're current.
export async function claimServiceEpoch(db: Db): Promise<Result<ServiceEpoch, DbFailure>> {
    const rowRes = await queryOne(
        db,
        EpochRowSchema,
        sql`update service set epoch = epoch + 1 where id = true returning epoch`,
    );
    if (!rowRes.ok) return rowRes;
    if (rowRes.value === null) {
        return err({ code: "DB_UNAVAILABLE", detail: "service singleton row is missing" });
    }
    return ok(rowRes.value.epoch);
}

export type EpochGuard = {
    readonly ownEpoch: ServiceEpoch;
    readonly isSuperseded: () => boolean;
    readonly checkNow: () => Promise<boolean>;
    readonly close: () => void;
};

// A failed read leaves the process serving and is reported, never treated as supersession:
// superseded is permanent, so failing closed would turn one database blip into an outage that
// lasts until restart. While the database is unreachable, requests fail on their own queries.
export function openEpochGuard(params: {
    readonly db: Db;
    readonly ownEpoch: ServiceEpoch;
    readonly pollIntervalMs: number;
    readonly onReadFailure: (failure: DbFailure) => void;
}): EpochGuard {
    let superseded = false;

    const checkNow = async (): Promise<boolean> => {
        if (superseded) return true;
        const current = await readServiceEpoch(params.db);
        if (!current.ok) {
            params.onReadFailure(current.error);
            return false;
        }
        if (current.value !== params.ownEpoch) {
            superseded = true;
        }
        return superseded;
    };

    const timer = setInterval(() => {
        void checkNow();
    }, params.pollIntervalMs);
    timer.unref();

    return {
        ownEpoch: params.ownEpoch,
        isSuperseded: () => superseded,
        checkNow,
        close: () => clearInterval(timer),
    };
}
