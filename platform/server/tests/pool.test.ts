import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import {
    compileSql,
    execute,
    openPool,
    parsePgTimestamptz,
    queryOne,
    sql,
    sqlIdent,
    toTimestamptz,
} from "../src/db/pool.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

test("an interpolated value is bound as a parameter, never spliced into the text", () => {
    const hostile = "'; drop table account; --";
    expect(compileSql(sql`select * from account where email = ${hostile}`)).toEqual({
        text: "select * from account where email = $1",
        values: [hostile],
    });
});

test("nested fragments are renumbered into one parameter sequence", () => {
    const inner = sql`b = ${2} and c = ${3}`;
    expect(compileSql(sql`a = ${1} and ${inner} and d = ${4}`)).toEqual({
        text: "a = $1 and b = $2 and c = $3 and d = $4",
        values: [1, 2, 3, 4],
    });
});

test("sqlIdent refuses anything but a lowercase snake_case identifier", () => {
    for (const bad of ['x"; drop table account; --', "Account", "1st", "", "a".repeat(64)]) {
        expect(() => sqlIdent(bad)).toThrow();
    }
});

test("a wire timestamp formats back to the same instant across leap days and centuries", () => {
    const cases: readonly (readonly [string, string])[] = [
        ["1970-01-01 00:00:00+00", "1970-01-01T00:00:00.000Z"],
        ["2024-02-29 23:59:59.999+00", "2024-02-29T23:59:59.999Z"],
        ["2000-02-29 12:00:00+00", "2000-02-29T12:00:00.000Z"],
        ["2100-03-01 00:00:00.001+00", "2100-03-01T00:00:00.001Z"],
        ["2026-11-18 03:05:00.456-05", "2026-11-18T08:05:00.456Z"],
    ];
    for (const [wire, iso] of cases) {
        expect(toTimestamptz(parsePgTimestamptz(wire))).toBe(iso);
    }
});

test("wire parsing truncates microseconds to milliseconds", () => {
    expect(parsePgTimestamptz("1970-01-01 00:00:01.999999+00")).toBe(EpochMs.parse(1_999));
});

test("a negative offset under one hour parses west of UTC", () => {
    expect(parsePgTimestamptz("1970-01-01 00:00:00-00:30")).toBe(EpochMs.parse(1_800_000));
});

test("an offset with seconds parses to the exact instant", () => {
    expect(parsePgTimestamptz("1970-01-01 00:00:00-00:44:30")).toBe(EpochMs.parse(2_670_000));
});

test("every pooled connection runs in UTC whatever the database default time zone", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ databaseUrl, nativeDb }) => {
        const current = await queryOne(
            nativeDb,
            z.object({ name: z.string() }),
            sql`select current_database() as name`,
        );
        invariant(current.ok && current.value !== null, "current_database() returned nothing");
        const altered = await execute(
            nativeDb,
            sql`alter database ${sqlIdent(current.value.name)} set timezone to 'Asia/Kathmandu'`,
        );
        expect(altered.ok).toBe(true);

        const fresh = openPool({ databaseUrl, maxConnections: 1 });
        const zone = await queryOne(
            fresh,
            z.object({ zone: z.string() }),
            sql`select current_setting('TimeZone') as zone`,
        );
        await fresh.close();
        expect(zone).toEqual(ok({ zone: "UTC" }));
    });
});
