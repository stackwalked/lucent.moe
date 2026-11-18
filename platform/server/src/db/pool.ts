import { readFileSync } from "node:fs";
import pg from "pg";
import type { z } from "zod";
import { ignoreErrors, invariant, raiseInvariant, tryAsync } from "../core/contain.ts";
import { ok, type Result } from "../core/result.ts";
import { EpochMs } from "../core/scalars.ts";

const { Pool, types } = pg;

const CONNECTION_TIMEOUT_MS = 5_000;

export type DbFailure =
    | { readonly code: "STATEMENT_TIMEOUT" }
    | { readonly code: "SERIALIZATION_FAILURE" }
    | { readonly code: "UNIQUE_VIOLATION"; readonly constraint: string | null }
    | { readonly code: "CHECK_VIOLATION"; readonly constraint: string | null }
    | { readonly code: "DB_UNAVAILABLE"; readonly detail: string };

const execSymbol: unique symbol = Symbol("lucent.db.exec");
const connectSymbol: unique symbol = Symbol("lucent.db.connect");
const dbBrand: unique symbol = Symbol("lucent.db.pool");
const txBrand: unique symbol = Symbol("lucent.db.tx");
const sqlBrand: unique symbol = Symbol("lucent.db.sql");
const scriptBrand: unique symbol = Symbol("lucent.db.script");

type RawQueryResult = {
    readonly command: string;
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number;
};

type RawExec = (
    text: string,
    values: readonly unknown[],
) => Promise<Result<RawQueryResult, DbFailure>>;

// Transaction control lives on the checked-out connection, not on `Tx`, so code handed a `Tx`
// cannot end the transaction it runs in.
export type CheckedOutClient = {
    readonly tx: Tx;
    readonly begin: () => Promise<Result<void, DbFailure>>;
    readonly commit: () => Promise<Result<"committed" | "rolled back", DbFailure>>;
    readonly rollback: () => Promise<Result<void, DbFailure>>;
    readonly release: () => void;
    readonly destroy: () => void;
};

export type Db = {
    readonly [dbBrand]: true;
    readonly [execSymbol]: RawExec;
    readonly [connectSymbol]: () => Promise<Result<CheckedOutClient, DbFailure>>;
    readonly close: () => Promise<void>;
};

export type Tx = {
    readonly [txBrand]: true;
    readonly [execSymbol]: RawExec;
};

export type Queryable = Db | Tx;

let wireParsersConfigured = false;

// PostgreSQL's timestamptz text output (`2026-11-18 08:25:00.123456+00`). Offsets carry their own
// sign, may be under an hour (`-00:30`) and may include seconds (pre-1900 LMT zones).
const TIMESTAMPTZ_WIRE =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)$/;

export function parsePgTimestamptz(raw: string): EpochMs {
    const match = TIMESTAMPTZ_WIRE.exec(raw);
    invariant(match !== null, `unrecognized PostgreSQL timestamptz wire string: ${raw}`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const millis = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));

    const offsetSign = match[8] === "-" ? -1 : 1;
    const offsetSeconds =
        Number(match[9] ?? 0) * 3_600 + Number(match[10] ?? 0) * 60 + Number(match[11] ?? 0);

    const days = daysFromCivil(year, month, day);
    const localMs =
        days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis;
    return EpochMs.parse(localMs - offsetSign * offsetSeconds * 1_000);
}

// Howard Hinnant's civil-to-days and days-to-civil algorithms (proleptic Gregorian, 1970-01-01 = 0).
function daysFromCivil(year: number, month: number, day: number): number {
    const y = month <= 2 ? year - 1 : year;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const m = month > 2 ? month - 3 : month + 9;
    const doy = Math.floor((153 * m + 2) / 5) + day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146_097 + doe - 719_468;
}

export function toTimestamptz(ms: EpochMs): string {
    const totalDays = Math.floor(ms / 86_400_000);
    const dayMs = ms - totalDays * 86_400_000;
    const z = totalDays + 719_468;
    const era = Math.floor(z / 146_097);
    const doe = z - era * 146_097;
    const yoe = Math.floor(
        (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) /
            365,
    );
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    const year = month <= 2 ? y + 1 : y;

    const hour = Math.floor(dayMs / 3_600_000);
    const rem1 = dayMs - hour * 3_600_000;
    const minute = Math.floor(rem1 / 60_000);
    const rem2 = rem1 - minute * 60_000;
    const second = Math.floor(rem2 / 1_000);
    const millis = rem2 - second * 1_000;

    const pad2 = (n: number) => String(n).padStart(2, "0");
    const pad3 = (n: number) => String(n).padStart(3, "0");
    const pad4 = (n: number) => String(n).padStart(4, "0");
    return `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${pad3(millis)}Z`;
}

function parsePgBytea(raw: string): Uint8Array {
    invariant(raw.startsWith("\\x"), "expected hex-format PostgreSQL bytea");
    const hex = raw.slice(2);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.byteLength; i++) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function ensurePgWireParsers(): void {
    if (wireParsersConfigured) return;
    // 1184 = timestamptz, 17 = bytea
    types.setTypeParser(1184, parsePgTimestamptz);
    types.setTypeParser(17, parsePgBytea);
    wireParsersConfigured = true;
}

function mapPgError(cause: unknown): DbFailure {
    if (typeof cause === "object" && cause !== null) {
        const record = cause as Record<string, unknown>;
        const pgCode = typeof record["code"] === "string" ? record["code"] : undefined;
        const constraint = typeof record["constraint"] === "string" ? record["constraint"] : null;
        if (pgCode === "57014") return { code: "STATEMENT_TIMEOUT" };
        if (pgCode === "40001" || pgCode === "40P01") return { code: "SERIALIZATION_FAILURE" };
        if (pgCode === "23505") return { code: "UNIQUE_VIOLATION", constraint };
        if (pgCode === "23514") return { code: "CHECK_VIOLATION", constraint };
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { code: "DB_UNAVAILABLE", detail };
}

function toRawResult(res: pg.QueryResult): RawQueryResult {
    return {
        command: res.command,
        rows: res.rows as Record<string, unknown>[],
        rowCount: res.rowCount ?? 0,
    };
}

export function openPool(params: {
    readonly databaseUrl: string;
    readonly maxConnections?: number;
    readonly statementTimeoutMs?: number;
    readonly applicationName?: string;
    readonly allowExitOnIdle?: boolean;
}): Db {
    ensurePgWireParsers();
    const pool = new Pool({
        connectionString: params.databaseUrl,
        max: params.maxConnections ?? 10,
        connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
        // Session time zone shapes every timestamptz rendered as text and every date arithmetic in
        // SQL; pinning it per connection keeps both independent of the database's default.
        options: "-c TimeZone=UTC",
        ...(params.allowExitOnIdle !== undefined
            ? { allowExitOnIdle: params.allowExitOnIdle }
            : {}),
        ...(params.statementTimeoutMs !== undefined
            ? { statement_timeout: params.statementTimeoutMs }
            : {}),
        ...(params.applicationName !== undefined
            ? { application_name: params.applicationName }
            : {}),
    });
    pool.on("error", () => {});

    return {
        [dbBrand]: true,
        async [execSymbol](text, values) {
            return await tryAsync(
                async () => toRawResult(await pool.query(text, [...values])),
                mapPgError,
            );
        },
        async [connectSymbol]() {
            const clientRes = await tryAsync(() => pool.connect(), mapPgError);
            if (!clientRes.ok) return clientRes;
            const client = clientRes.value;
            let inFlight = false;

            const exec: RawExec = async (text, values) => {
                invariant(
                    !inFlight,
                    "concurrent queries on a single Tx are forbidden; await queries sequentially",
                );
                inFlight = true;
                const outcome = await tryAsync(
                    async () => toRawResult(await client.query(text, [...values])),
                    mapPgError,
                );
                inFlight = false;
                return outcome;
            };
            const control = async (text: string): Promise<Result<void, DbFailure>> => {
                const res = await exec(text, []);
                if (!res.ok) return res;
                return ok(undefined);
            };

            let released = false;
            return ok({
                tx: { [txBrand]: true, [execSymbol]: exec },
                begin: () => control("begin"),
                // PostgreSQL answers COMMIT on a transaction a failed statement aborted with a
                // ROLLBACK tag and no error.
                async commit() {
                    const res = await exec("commit", []);
                    if (!res.ok) return res;
                    return ok(res.value.command === "COMMIT" ? "committed" : "rolled back");
                },
                rollback: () => control("rollback"),
                release: () => {
                    if (released) return;
                    released = true;
                    client.release();
                },
                destroy: () => {
                    if (released) return;
                    released = true;
                    client.on("error", () => {});
                    client.release(true);
                },
            });
        },
        async close() {
            await ignoreErrors(() => pool.end());
        },
    };
}

export async function checkoutClient(db: Db): Promise<Result<CheckedOutClient, DbFailure>> {
    return await db[connectSymbol]();
}

export type SqlFragment = {
    readonly [sqlBrand]: true;
    readonly strings: readonly string[];
    readonly values: readonly unknown[];
};

function isSqlFragment(value: unknown): value is SqlFragment {
    return typeof value === "object" && value !== null && sqlBrand in value;
}

export function sql(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlFragment {
    return {
        [sqlBrand]: true,
        strings: [...strings],
        values,
    };
}

export function sqlIdent(identifier: string): SqlFragment {
    invariant(/^[a-z_][a-z0-9_]{0,62}$/.test(identifier), `unsafe SQL identifier: ${identifier}`);
    return {
        [sqlBrand]: true,
        strings: [`"${identifier}"`],
        values: [],
    };
}

export function compileSql(fragment: SqlFragment): {
    readonly text: string;
    readonly values: readonly unknown[];
} {
    let text = "";
    const values: unknown[] = [];

    const append = (frag: SqlFragment): void => {
        text += frag.strings[0] ?? "";
        for (let i = 0; i < frag.values.length; i++) {
            const val = frag.values[i];
            if (isSqlFragment(val)) {
                append(val);
            } else {
                values.push(val);
                text += `$${values.length}`;
            }
            text += frag.strings[i + 1] ?? "";
        }
    };

    append(fragment);
    return { text, values };
}

// Multi-statement SQL with no bound values, for migrations. Its text can only come from a file, so
// no runtime value can ever be spliced into it.
export type SqlScript = {
    readonly [scriptBrand]: true;
    readonly text: string;
};

export function readSqlScript(path: string): SqlScript {
    return { [scriptBrand]: true, text: readFileSync(path, "utf8") };
}

export async function executeScript(
    q: Queryable,
    script: SqlScript,
): Promise<Result<void, DbFailure>> {
    const res = await q[execSymbol](script.text, []);
    if (!res.ok) return res;
    return ok(undefined);
}

export async function execute(
    q: Queryable,
    statement: SqlFragment,
): Promise<Result<number, DbFailure>> {
    const compiled = compileSql(statement);
    const res = await q[execSymbol](compiled.text, compiled.values);
    if (!res.ok) return res;
    return ok(res.value.rowCount);
}

export async function queryAll<RowSchema extends z.ZodType>(
    q: Queryable,
    schema: RowSchema,
    statement: SqlFragment,
): Promise<Result<readonly z.output<RowSchema>[], DbFailure>> {
    const compiled = compileSql(statement);
    const res = await q[execSymbol](compiled.text, compiled.values);
    if (!res.ok) return res;
    const decoded: z.output<RowSchema>[] = [];
    for (const rawRow of res.value.rows) {
        const parsed = schema.safeParse(rawRow);
        if (!parsed.success) {
            raiseInvariant(
                `SQL row failed schema decoding: ${parsed.error.issues[0]?.message ?? "invalid"}`,
            );
        }
        decoded.push(parsed.data);
    }
    return ok(decoded);
}

export async function queryOne<RowSchema extends z.ZodType>(
    q: Queryable,
    schema: RowSchema,
    statement: SqlFragment,
): Promise<Result<z.output<RowSchema> | null, DbFailure>> {
    const res = await queryAll(q, schema, statement);
    if (!res.ok) return res;
    invariant(res.value.length <= 1, `queryOne expected at most 1 row, got ${res.value.length}`);
    return ok(res.value[0] ?? null);
}
