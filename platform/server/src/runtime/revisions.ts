import { ok, type Result } from "@lucent/core/result";
import { toHex } from "@lucent/core/scalars";
import { z } from "zod";
import { type DbFailure, execute, queryAll, sql, type Tx } from "../db/pool.ts";
import { type DataChange, decideDataRevisions } from "./revisions.rules.ts";
import { StartModules } from "./starts.ts";

// Raises the data revision of the release's live sessions a change touches, so their next lease
// says there is something new to fetch. The sessions are locked by id, after whatever the writer
// locked before (its caller's account, the release's own lock): runtime_session's place in the
// canonical order. Returns how many rose.
export async function bumpDataRevisions(
    tx: Tx,
    params: { readonly releaseId: Uint8Array; readonly change: DataChange },
): Promise<Result<number, DbFailure>> {
    const rows = await queryAll(
        tx,
        z.object({
            id: z.instanceof(Uint8Array),
            data_revision: z.coerce.bigint(),
            modules: StartModules,
            asked_modules: StartModules,
        }),
        sql`select r.id, r.data_revision, s.modules, r.asked_modules
            from runtime_session r join session_start s on s.id = r.start_id
            where r.release_id = ${params.releaseId} and r.ended_at is null
            order by r.id
            for update of r`,
    );
    if (!rows.ok) return rows;
    const plan = decideDataRevisions(
        rows.value.map((row) => ({
            id: row.id,
            revision: row.data_revision,
            builds: [...row.modules, ...row.asked_modules],
        })),
        params.change,
    );
    if (!plan.ok) return plan;
    if (plan.value.length === 0) return ok(0);
    const bumps = JSON.stringify(
        plan.value.map((bump) => ({ id: toHex(bump.id), revision: bump.revision.toString() })),
    );
    const updated = await execute(
        tx,
        sql`update runtime_session r set data_revision = b.revision
            from jsonb_to_recordset(${bumps}::jsonb) as b(id text, revision bigint)
            where r.id = decode(b.id, 'hex')`,
    );
    if (!updated.ok) return updated;
    return ok(updated.value);
}
