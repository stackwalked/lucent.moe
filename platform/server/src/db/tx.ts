import { onThrowCleanup, raiseInvariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { checkoutClient, type Db, type DbFailure, queryOne, sql, type Tx } from "./pool.ts";

export type TxStep<T, E> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E; readonly persistOnError?: true };

export function errCommit<E>(error: E): TxStep<never, E> {
    return { ok: false, error, persistOnError: true };
}

const NowRowSchema = z.object({
    now: EpochMs,
});

type StepValue<S> = S extends { readonly ok: true; readonly value: infer V } ? V : never;
type StepError<S> = S extends { readonly ok: false; readonly error: infer E } ? E : never;

export async function withTx<S extends TxStep<unknown, unknown>>(
    db: Db,
    work: (tx: Tx, txNow: EpochMs) => Promise<S>,
): Promise<Result<StepValue<S>, StepError<S> | DbFailure>> {
    const checkedOut = await checkoutClient(db);
    if (!checkedOut.ok) return checkedOut;
    const client = checkedOut.value;

    const rollbackAndRelease = async (): Promise<void> => {
        const rolledBack = await client.rollback();
        if (rolledBack.ok) {
            client.release();
            return;
        }
        client.destroy();
    };

    const beginRes = await client.begin();
    if (!beginRes.ok) {
        client.destroy();
        return beginRes;
    }

    const nowRes = await queryOne(client.tx, NowRowSchema, sql`select now() as now`);
    if (!nowRes.ok) {
        await rollbackAndRelease();
        return nowRes;
    }
    if (nowRes.value === null) {
        await rollbackAndRelease();
        return err<DbFailure>({ code: "DB_UNAVAILABLE", detail: "missing now() row" });
    }

    const nowValue = nowRes.value.now;
    // Uncontained defects/exceptions may leave a query in flight on the wire; destroy the
    // checked-out socket so PostgreSQL aborts the transaction and the pool never deadlocks.
    const step = (await onThrowCleanup(() => work(client.tx, nowValue), client.destroy)) as TxStep<
        StepValue<S>,
        StepError<S>
    >;

    if (!step.ok && step.persistOnError !== true) {
        await rollbackAndRelease();
        return err(step.error);
    }

    const commitRes = await client.commit();
    if (!commitRes.ok) {
        client.destroy();
        return commitRes;
    }
    client.release();
    if (commitRes.value === "rolled back") {
        // Every failed statement surfaces as a DbFailure, so reaching here means the work dropped
        // one and returned success for writes that never happened.
        raiseInvariant("transaction was aborted by a failed statement its work did not return");
    }
    if (!step.ok) return err(step.error);
    return ok(step.value);
}
