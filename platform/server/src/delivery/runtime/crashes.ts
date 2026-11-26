import { trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { ChannelId, EpochMs, ProductId, toBase64Url, toHex } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Db, type DbFailure, queryAll, sql, toTimestamptz } from "../../base/db/pool.ts";
import { type Forbidden, readAsStaff } from "../../identity/authority/staff.ts";
import { REVIEW_ACTION } from "../risk/review.ts";

// The crashes modules sent on the reports route, as staff read them: per product and release,
// grouped by where they happened (module and RVA), the group with the newest crash first. Read
// under the review queue's action. A group's place moves when a new crash joins it, so a page
// read after that may repeat or skip a group; the list is for spotting, not counting.

const PAGE_SIZE = 50;

export type CrashSummary = {
    readonly productId: ProductId;
    readonly releaseId: string;
    readonly channel: ChannelId;
    readonly sealNumber: string | null;
    // Hex; all zeros for the module's own image.
    readonly moduleHash: string;
    readonly rva: number;
    readonly crashes: number;
    readonly firstAt: EpochMs;
    readonly lastAt: EpochMs;
    readonly exceptionCode: number;
    readonly frames: readonly number[];
};

export type CrashPage = {
    readonly items: readonly CrashSummary[];
    readonly nextCursor: string | null;
};

export type CrashesRefusal = Forbidden | { readonly code: "INVALID_CURSOR" };

const U32 = z.coerce.number().int().min(0).max(0xffff_ffff);

const SummaryRow = z.object({
    product_id: ProductId,
    release_id: z.instanceof(Uint8Array),
    channel: ChannelId,
    seal_number: z.string().nullable(),
    module_hash: z.string(),
    rva: U32,
    crashes: z.coerce.number().int(),
    first_at: EpochMs,
    last_at: EpochMs,
    latest_id: z.string(),
    exception_code: U32,
    frames: z.array(U32),
});

// The last group's sort key, as base64url JSON: opaque to web, checked on the way back.
const CursorKey = z.strictObject({
    lastAt: EpochMs,
    latestId: z.string().regex(/^[1-9][0-9]{0,18}$/),
});
type CursorKey = z.output<typeof CursorKey>;

function toCursor(key: CursorKey): string {
    return toBase64Url(new TextEncoder().encode(JSON.stringify(key)));
}

function fromCursor(cursor: string): Result<CursorKey, { readonly code: "INVALID_CURSOR" }> {
    const decoded = trySync(
        (): unknown =>
            JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                    Uint8Array.fromBase64(cursor, { alphabet: "base64url" }),
                ),
            ),
        () => ({ code: "INVALID_CURSOR" as const }),
    );
    if (!decoded.ok) return decoded;
    const parsed = CursorKey.safeParse(decoded.value);
    return parsed.success ? ok(parsed.data) : err({ code: "INVALID_CURSOR" });
}

export async function listCrashSummaries(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly productId: string | null;
        readonly releaseId: string | null;
        readonly cursor: string | null;
    },
): Promise<Result<CrashPage, CrashesRefusal | DbFailure>> {
    const after = params.cursor === null ? null : fromCursor(params.cursor);
    if (after !== null && !after.ok) return after;
    const { productId, releaseId } = params;
    return await readAsStaff(db, { caller: params.caller, actions: [REVIEW_ACTION] }, async (q) => {
        const rows = await queryAll(
            q,
            SummaryRow,
            sql`select g.product_id, g.release_id, r.channel,
                       (select max(s.number) from release_seal s
                        where s.release_id = g.release_id)::text as seal_number,
                       g.module_hash::text as module_hash, g.rva, g.crashes, g.first_at, g.last_at,
                       g.latest_id::text as latest_id, latest.exception_code, latest.frames
                from (select product_id, release_id, module_hash, rva, count(*) as crashes,
                             min(received_at) as first_at, max(received_at) as last_at,
                             max(id) as latest_id
                      from module_report
                      where kind = 'crash'
                        ${productId === null ? sql`` : sql`and product_id = ${productId}`}
                        ${releaseId === null ? sql`` : sql`and release_id = ${Uint8Array.fromHex(releaseId)}`}
                      group by product_id, release_id, module_hash, rva) g
                join module_report latest on latest.id = g.latest_id
                join release r on r.id = g.release_id
                ${
                    after === null
                        ? sql``
                        : sql`where (g.last_at, g.latest_id)
                                  < (${toTimestamptz(after.value.lastAt)}::timestamptz,
                                     ${after.value.latestId}::bigint)`
                }
                order by g.last_at desc, g.latest_id desc
                limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const items = rows.value.slice(0, PAGE_SIZE);
        const last = items.at(-1);
        return ok({
            items: items.map((row) => ({
                productId: row.product_id,
                releaseId: toHex(row.release_id),
                channel: row.channel,
                sealNumber: row.seal_number,
                moduleHash: BigInt(row.module_hash).toString(16).padStart(16, "0"),
                rva: row.rva,
                crashes: row.crashes,
                firstAt: row.first_at,
                lastAt: row.last_at,
                exceptionCode: row.exception_code,
                frames: row.frames,
            })),
            nextCursor:
                rows.value.length > PAGE_SIZE && last !== undefined
                    ? toCursor({ lastAt: last.last_at, latestId: last.latest_id })
                    : null,
        });
    });
}
