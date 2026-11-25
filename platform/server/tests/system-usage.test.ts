import { describe, expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { type AccountId, EpochMs } from "@lucent/core/scalars";
import { type Db, execute, sql } from "../src/db/pool.ts";
import { decideUsageWindow } from "../src/system/usage.rules.ts";
import { readUsage } from "../src/system/usage.ts";
import { seedAccount, seedRoot, steppedUp } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

function at(iso: string): EpochMs {
    return EpochMs.parse(Date.parse(iso));
}

describe("the usage window", () => {
    test.each([
        [
            "a Sunday's last instant ends its own week",
            "2027-01-03T23:59:59.999Z",
            "2027-01-04",
            "2026-10-12",
        ],
        [
            "a Monday's first instant starts the next",
            "2027-01-04T00:00:00.000Z",
            "2027-01-11",
            "2026-10-19",
        ],
        ["a Thursday in ISO week 53", "2026-12-31T12:00:00.000Z", "2027-01-04", "2026-10-12"],
        [
            "the epoch's first week is cut at the epoch",
            "1970-01-01T00:00:00.000Z",
            "1970-01-05",
            "1970-01-01",
        ],
    ])("%s", (_name, endingWith, until, from) => {
        expect(decideUsageWindow(at(endingWith))).toEqual(
            ok({ from: at(`${from}T00:00:00.000Z`), until: at(`${until}T00:00:00.000Z`) }),
        );
    });
});

async function seedRelease(
    db: Db,
    params: {
        readonly n: number;
        readonly product: string;
        readonly channel: string;
        readonly number: number;
    },
): Promise<void> {
    const id = sql`decode(lpad(to_hex(${params.n}::int), 32, '0'), 'hex')`;
    expect(
        await execute(
            db,
            sql`insert into release (id, product_id, channel) values (${id}, ${params.product}, ${params.channel})`,
        ),
    ).toEqual(ok(1));
    expect(
        await execute(
            db,
            sql`insert into release_seal (product_id, channel, number, release_id, seal)
                values (${params.product}, ${params.channel}, ${params.number}, ${id}, '\\x01')`,
        ),
    ).toEqual(ok(1));
}

async function seedDevice(db: Db, params: { readonly n: number; readonly account: AccountId }) {
    expect(
        await execute(
            db,
            sql`insert into device (id, account_id, jkt, public_key, storage, enrolled_at)
                values (decode(lpad(to_hex(${params.n}::int), 32, '0'), 'hex'), ${params.account},
                        ${`jkt-${params.n}`}, '{}', 'software', '2026-01-01T00:00:00Z')`,
        ),
    ).toEqual(ok(1));
}

// A session row as the native path leaves it, with only what usage reads chosen by the test.
async function seedSession(
    db: Db,
    s: {
        readonly n: number;
        readonly account: AccountId;
        readonly device: number;
        readonly release: number;
        readonly product: string;
        readonly channel: string;
        readonly number: number;
        readonly start: string;
        readonly leaseExpiresAt: string;
        readonly endedAt: string | null;
    },
): Promise<void> {
    const id = sql`decode(lpad(to_hex(${s.n}::int), 32, '0'), 'hex')`;
    const device = sql`decode(lpad(to_hex(${s.device}::int), 32, '0'), 'hex')`;
    const release = sql`decode(lpad(to_hex(${s.release}::int), 32, '0'), 'hex')`;
    const key = sql`decode(repeat('ab', 32), 'hex')`;
    const nonce = sql`decode(repeat('cd', 16), 'hex')`;
    expect(
        await execute(
            db,
            sql`insert into session_start (id, account_id, device_id, product_id, channel, release_id,
                                           created_at, expires_at, consumed_at, release_number)
                values (${id}, ${s.account}, ${device}, ${s.product}, ${s.channel}, ${release},
                        ${s.start}::timestamptz, ${s.start}::timestamptz + interval '1 minute',
                        ${s.start}::timestamptz, ${s.number})`,
        ),
    ).toEqual(ok(1));
    expect(
        await execute(
            db,
            sql`insert into runtime_session (
                    id, start_id, account_id, device_id, product_id, channel, release_id,
                    slot_generation, module_key, server_key, boot_info_version, image_kind,
                    image_base, image_size, entitled_everything, entitled_features, created_at,
                    lease_sequence, lease_nonce, lease_challenge_nonce, lease_challenge_offset,
                    lease_challenge_size, loader_challenge_nonce, loader_challenge_offset,
                    loader_challenge_size, lease_issued_at, lease_expires_at, frame_in_sequence,
                    frame_out_sequence, ended_at, end_reason)
                values (${id}, ${id}, ${s.account}, ${device}, ${s.product}, ${s.channel}, ${release},
                        1, ${key}, ${key}, 1, 'mapped', 0, 4096, true, '{}', ${s.start}::timestamptz,
                        1, ${nonce}, ${nonce}, 0, 16, ${nonce}, 0, 16,
                        ${s.leaseExpiresAt}::timestamptz - interval '1 minute',
                        ${s.leaseExpiresAt}::timestamptz, 0, 1, ${s.endedAt}::timestamptz,
                        ${s.endedAt === null ? null : "closed"})`,
        ),
    ).toEqual(ok(1));
}

describe("usage", () => {
    test("weekly active accounts and sessions per release match a hand count across ISO week 53", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(1210);
            const root = await seedRoot(nativeDb, rng);
            const a = await seedAccount(nativeDb, rng, "a@lucent.test");
            const b = await seedAccount(nativeDb, rng, "b@lucent.test");
            const c = await seedAccount(nativeDb, rng, "c@lucent.test");
            await seedDevice(nativeDb, { n: 1, account: a });
            await seedDevice(nativeDb, { n: 2, account: b });
            await seedDevice(nativeDb, { n: 3, account: c });
            await seedRelease(nativeDb, { n: 1, product: "cs2", channel: "stable", number: 1 });
            await seedRelease(nativeDb, { n: 2, product: "cs2", channel: "alpha", number: 2 });
            await seedRelease(nativeDb, { n: 3, product: "osu", channel: "stable", number: 1 });
            const cs2Stable = { release: 1, product: "cs2", channel: "stable", number: 1 } as const;
            const cs2Alpha = { release: 2, product: "cs2", channel: "alpha", number: 2 } as const;
            const osuStable = { release: 3, product: "osu", channel: "stable", number: 1 } as const;
            const closed = (start: string, end: string) => ({
                start,
                endedAt: end,
                leaseExpiresAt: end,
            });
            const sessions = [
                // 2026-W53 (Mon 2026-12-28), twice by the same account: one account.
                {
                    account: a,
                    device: 1,
                    ...cs2Stable,
                    ...closed("2026-12-31T10:00Z", "2026-12-31T11:00Z"),
                },
                {
                    account: a,
                    device: 1,
                    ...cs2Stable,
                    ...closed("2027-01-02T10:00Z", "2027-01-02T11:00Z"),
                },
                // Sunday night into Monday: active in 2026-W53 and 2027-W01.
                {
                    account: b,
                    device: 2,
                    ...cs2Stable,
                    ...closed("2027-01-03T23:30Z", "2027-01-04T00:30Z"),
                },
                // 2027-W01 only.
                {
                    account: c,
                    device: 3,
                    ...cs2Alpha,
                    ...closed("2027-01-05T12:00Z", "2027-01-05T13:00Z"),
                },
                // A crashed loader: its last lease ran out in 2026-W52, the sweep ended it in W53.
                {
                    account: a,
                    device: 1,
                    ...osuStable,
                    start: "2026-12-27T23:00Z",
                    leaseExpiresAt: "2026-12-27T23:59Z",
                    endedAt: "2026-12-28T02:00Z",
                },
                // Started the night before the window: active in its first week (2026-W43), but
                // not a session started within it.
                {
                    account: c,
                    device: 3,
                    ...cs2Stable,
                    ...closed("2026-10-18T23:00Z", "2026-10-19T00:30Z"),
                },
                // The week after the window.
                {
                    account: b,
                    device: 2,
                    ...cs2Stable,
                    ...closed("2027-01-11T00:00Z", "2027-01-11T01:00Z"),
                },
            ];
            for (const [i, session] of sessions.entries()) {
                await seedSession(nativeDb, { n: i + 1, ...session });
            }

            const usage = await readUsage(nativeDb, {
                caller: await steppedUp(nativeDb, root),
                endingWith: at("2027-01-06T08:00:00.000Z"),
            });
            expect(usage).toEqual(
                ok({
                    from: at("2026-10-19T00:00:00.000Z"),
                    until: at("2027-01-11T00:00:00.000Z"),
                    weeks: [
                        {
                            weekStart: at("2027-01-04T00:00:00.000Z"),
                            isoYear: 2027,
                            isoWeek: 1,
                            productId: "cs2",
                            accounts: 2,
                        },
                        {
                            weekStart: at("2026-12-28T00:00:00.000Z"),
                            isoYear: 2026,
                            isoWeek: 53,
                            productId: "cs2",
                            accounts: 2,
                        },
                        {
                            weekStart: at("2026-12-21T00:00:00.000Z"),
                            isoYear: 2026,
                            isoWeek: 52,
                            productId: "osu",
                            accounts: 1,
                        },
                        {
                            weekStart: at("2026-10-19T00:00:00.000Z"),
                            isoYear: 2026,
                            isoWeek: 43,
                            productId: "cs2",
                            accounts: 1,
                        },
                    ],
                    releases: [
                        {
                            productId: "cs2",
                            channel: "alpha",
                            number: "2",
                            sessions: 1,
                            accounts: 1,
                        },
                        {
                            productId: "cs2",
                            channel: "stable",
                            number: "1",
                            sessions: 3,
                            accounts: 2,
                        },
                        {
                            productId: "osu",
                            channel: "stable",
                            number: "1",
                            sessions: 1,
                            accounts: 1,
                        },
                    ],
                }),
            );

            expect(
                await readUsage(nativeDb, {
                    caller: await steppedUp(nativeDb, a),
                    endingWith: null,
                }),
            ).toEqual(err({ code: "FORBIDDEN" }));
        });
    });
});
