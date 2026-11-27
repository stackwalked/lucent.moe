import { trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { toBase64Url } from "@lucent/core/scalars";
import { z } from "zod";
import { type SqlFragment, sql } from "./pool.ts";

// A page cursor over rows sorted by (time, id): the last row's own sort key as base64url JSON,
// opaque to web and checked on the way back. The time travels as whole microseconds since the
// epoch, because a timestamptz keeps microseconds and a JS Date or a millisecond string rounds
// them away, which skips every row that shares the cut-off millisecond. Digits and a uuid only,
// so nothing in a cursor can make the query that takes it fail.
export type Keyset = { readonly micros: string; readonly id: string };

const Key = z.tuple([z.string().regex(/^\d{1,16}$/), z.uuid()]);

export function toKeyset(key: Keyset): string {
    return toBase64Url(new TextEncoder().encode(JSON.stringify([key.micros, key.id])));
}

export function parseKeyset(cursor: string): Result<Keyset, { readonly code: "INVALID_CURSOR" }> {
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
    const parsed = Key.safeParse(decoded.value);
    return parsed.success
        ? ok({ micros: parsed.data[0], id: parsed.data[1] })
        : err({ code: "INVALID_CURSOR" });
}

// A row's time column as the cursor's micros: selected beside the row to build its cursor.
export function microsOf(column: SqlFragment): SqlFragment {
    return sql`(extract(epoch from ${column}) * 1000000)::bigint::text`;
}

// Rows after the cursor's, in descending (time, id) order.
export function beforeKeyset(
    columns: { readonly time: SqlFragment; readonly id: SqlFragment },
    key: Keyset,
): SqlFragment {
    return sql`(${columns.time}, ${columns.id}) < (
        timestamptz 'epoch' + ${key.micros}::bigint * interval '1 microsecond', ${key.id}::uuid)`;
}
