import { expect, test } from "bun:test";
import { deliverAll, toBundleBytes } from "@lucent/bundle/bundle";
import { type FactSetHeader, fromLiteral, type ModuleKey } from "@lucent/bundle/fact-set";
import { leafHash, treeRoot } from "@lucent/bundle/merkle";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import type { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryOne, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { sweepRetention } from "../src/base/jobs/retention.ts";
import { lockBuildCoverage } from "../src/delivery/facts/coverage-lock.ts";
import { listReleaseOverrides, setOverride } from "../src/delivery/facts/overrides.ts";
import { promoteFactSet } from "../src/delivery/facts/promotion.ts";
import { listUpdateDays } from "../src/delivery/facts/updates.ts";
import { decideReviewItem, listReviewItems } from "../src/delivery/risk/review.ts";
import { scoreRisk } from "../src/delivery/risk/scoring.ts";
import { seedRootOnce } from "./auth-fixtures.ts";
import { grantRole, scalar, seedAccount, seedRole, steppedUp } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    createTestModule,
    enroll,
    entitledMember,
    FEATURES,
    type NativeHarness,
    publishBoth,
    type Releases,
    refusalCodeOf,
    sessionPath,
    signIn,
    startOk,
    type TestLoader,
    type TestModule,
} from "./native-fixtures.ts";

const GAME: ModuleKey = { nameHash: 0x1234n, timeDateStamp: 0x5566_7788, sizeOfImage: 0x0040_0000 };
const OTHER: ModuleKey = { nameHash: 0x4321n, timeDateStamp: 7, sizeOfImage: 8 };

type Running = {
    readonly loader: TestLoader;
    readonly module: TestModule;
    readonly path: string;
    readonly accountId: AccountId;
};

async function run(
    harness: NativeHarness,
    releases: Releases,
    params: { readonly email: string; readonly reported: readonly ModuleKey[] },
): Promise<Running> {
    const member = await entitledMember(harness, { email: params.email, channels: ["alpha"] });
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    const started = await startOk(loader, releases, params.reported);
    const module = createTestModule(harness.rng, harness.signer.publicKey);
    const opened = await loader.send({
        method: "POST",
        path: `${started.path}/session`,
        body: await module.hello(releases.module.id),
    });
    invariant(opened.status === 200, `the session was refused: ${refusalCodeOf(opened)}`);
    await module.acceptSession(opened.bytes);
    return { loader, module, path: sessionPath(module.session()), accountId: member.accountId };
}

async function renew(running: Running, loaderAnswer: Uint8Array | null = null) {
    const sent = await running.loader.send({
        method: "POST",
        path: `${running.path}/lease`,
        body: running.module.renewal({ loaderAnswer }),
    });
    invariant(sent.status === 200, `the renewal was refused: ${refusalCodeOf(sent)}`);
    return await running.module.acceptLease(sent.bytes);
}

async function askData(running: Running, modules: readonly ModuleKey[]) {
    const sent = await running.loader.send({
        method: "POST",
        path: `${running.path}/data`,
        body: running.module.dataRequest(modules),
    });
    invariant(sent.status === 200, `the data request was refused: ${refusalCodeOf(sent)}`);
    return running.module.acceptData(sent.bytes);
}

async function staff(db: Db, rng: SeededRng) {
    return await steppedUp(db, await seedRootOnce(db, rng));
}

// A set staged for the builds as publishing stores one, unsigned and not yet current.
async function stageSet(
    db: Db,
    release: Uint8Array,
    modules: readonly ModuleKey[],
    revision: number,
): Promise<string> {
    const entries = [fromLiteral(0x10n, 0x11n)];
    const header: FactSetHeader = {
        game: 1,
        revision,
        modules,
        findersCommit: new Uint8Array(20),
        manifestDigest: new Uint8Array(32),
        entryCount: entries.length,
        merkleRoot: treeRoot(entries.map(leafHash)),
        signature: new Uint8Array(64),
    };
    const bundle = toBundleBytes([deliverAll({ header, entries })]);
    const keys = new Uint8Array(8);
    new DataView(keys.buffer).setBigUint64(0, 0x10n, true);
    const set = await queryOne(
        db,
        z.object({ id: z.string() }),
        sql`insert into fact_set (release_id, bundle, fact_keys)
            values (${release}, ${bundle}, ${keys}) returning id::text as id`,
    );
    invariant(set.ok && set.value !== null, "storing the set failed");
    for (const build of modules) {
        const listed = await execute(
            db,
            sql`insert into fact_set_build
                    (set_id, release_id, name_hash, time_date_stamp, size_of_image, revision)
                values (${set.value.id}::bigint, ${release}, ${build.nameHash.toString()}::numeric,
                        ${build.timeDateStamp}, ${build.sizeOfImage}, ${revision})`,
        );
        invariant(listed.ok, "listing the set's build failed");
    }
    return set.value.id;
}

const ESP = FEATURES[1].key;

test("a kill switch set in admin raises the running session's data revision on its next lease and data response", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_901);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, {
            email: "kill@lucent.test",
            reported: [GAME],
        });
        expect(running.module.held().dataRevision).toBe(0n);
        expect((await renew(running)).dataRevision).toBe(0n);

        const caller = await staff(nativeDb, rng);
        const switched = await setOverride(nativeDb, {
            caller,
            releaseId: releases.module.id,
            target: { kind: "feature", key: ESP },
            off: true,
            signer: null,
        });
        expect(switched).toEqual({ ok: true, value: { changed: true, revision: 1 } });

        expect((await renew(running)).dataRevision).toBe(1n);
        expect((await askData(running, [GAME])).dataRevision).toBe(1n);

        const again = await setOverride(nativeDb, {
            caller,
            releaseId: releases.module.id,
            target: { kind: "feature", key: ESP },
            off: true,
            signer: null,
        });
        expect(again).toEqual({ ok: true, value: { changed: false, revision: 1 } });
        expect((await renew(running)).dataRevision).toBe(1n);

        const listed = await listReleaseOverrides(nativeDb, {
            caller,
            releaseId: releases.module.id,
        });
        invariant(listed.ok, "listing the overrides failed");
        expect(listed.value.revision).toBe(1);
        expect(listed.value.features.map((f) => [f.tag, f.off])).toEqual([
            ["aim", false],
            ["esp", true],
        ]);
        const audited = await scalar(
            nativeDb,
            z.coerce.number(),
            sql`select count(*) as value from audit where operation = 'fact_override.set'`,
        );
        expect(audited).toBe(1);
    });
});

test("a key the release's manifest doesn't declare can't be switched off", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_902);
        const releases = await publishBoth(nativeDb, rng);
        const refused = await setOverride(nativeDb, {
            caller: await staff(nativeDb, rng),
            releaseId: releases.module.id,
            target: { kind: "capability", key: ESP },
            off: true,
            signer: null,
        });
        expect(refused).toEqual({ ok: false, error: { code: "UNKNOWN_TARGET" } });
        const loader = await setOverride(nativeDb, {
            caller: await staff(nativeDb, rng),
            releaseId: releases.loader.id,
            target: { kind: "feature", key: ESP },
            off: true,
            signer: null,
        });
        expect(loader).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    });
});

test("promoting a set raises the revision of sessions running its build, a late build they asked for included, and no other", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_903);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const onGame = await run(harness, releases, {
            email: "game@lucent.test",
            reported: [GAME],
        });
        const onOther = await run(harness, releases, {
            email: "other@lucent.test",
            reported: [OTHER],
        });
        const caller = await staff(nativeDb, rng);

        const forGame = await stageSet(nativeDb, releases.module.id, [GAME], 1);
        const promoted = await promoteFactSet(nativeDb, {
            caller,
            releaseId: releases.module.id,
            setId: forGame,
        });
        expect(promoted).toEqual({ ok: true, value: { changed: true } });
        expect((await renew(onGame)).dataRevision).toBe(1n);
        expect((await renew(onOther)).dataRevision).toBe(0n);

        expect((await askData(onOther, [GAME])).dataRevision).toBe(0n);
        const next = await stageSet(nativeDb, releases.module.id, [GAME], 2);
        await promoteFactSet(nativeDb, { caller, releaseId: releases.module.id, setId: next });
        expect((await renew(onGame)).dataRevision).toBe(2n);
        expect((await renew(onOther)).dataRevision).toBe(1n);
    });
});

test("the first report of a build and the promotion that covers it give its update-day latency", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_904);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        await run(harness, releases, { email: "update@lucent.test", reported: [GAME] });
        const caller = await staff(nativeDb, rng);

        const waiting = await listUpdateDays(nativeDb, { caller });
        invariant(waiting.ok, "listing update days failed");
        expect(
            waiting.value.days.map((day) => [day.productId, day.build.nameHash, day.latency.state]),
        ).toEqual([["cs2", "0000000000001234", "waiting"]]);

        const backdated = await execute(
            nativeDb,
            sql`update module_build_seen set first_reported_at = now() - interval '2 hours'`,
        );
        invariant(backdated.ok, "backdating the report failed");
        const setId = await stageSet(nativeDb, releases.module.id, [GAME], 1);
        await promoteFactSet(nativeDb, { caller, releaseId: releases.module.id, setId });
        const covered = await listUpdateDays(nativeDb, { caller });
        invariant(covered.ok, "listing update days failed");
        expect(covered.value.truncated).toBe(false);
        const [day] = covered.value.days;
        invariant(day?.latency.state === "covered", "the build is covered");
        expect(day.latency.latencyMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1_000);
        expect(day.latency.latencyMs).toBeLessThan(3 * 60 * 60 * 1_000);
    });
});

test("renewals the loader leaves unanswered become signals, and the scoring job opens one review item staff decide once", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_905);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, {
            email: "quiet@lucent.test",
            reported: [GAME],
        });
        await renew(running);
        await renew(running, new Uint8Array(32).fill(1));
        await renew(running);
        await renew(running);
        const signals = await scalar(
            nativeDb,
            z.coerce.number(),
            sql`select count(*) as value from risk_signal where kind = 'loader_silent'`,
        );
        expect(signals).toBe(2);

        // One silent session stays below the threshold; a second, observed outside this one, opens
        // the item.
        expect(await scoreRisk(nativeDb)).toEqual({ ok: true, value: { changed: 0, failed: 0 } });
        const second = await execute(
            nativeDb,
            sql`insert into risk_signal (account_id, kind, observed_at)
                values (${running.accountId}, 'loader_silent', now())`,
        );
        invariant(second.ok, "adding a signal failed");
        expect(await scoreRisk(nativeDb)).toEqual({ ok: true, value: { changed: 1, failed: 0 } });
        expect(await scoreRisk(nativeDb)).toEqual({ ok: true, value: { changed: 0, failed: 0 } });

        const caller = await staff(nativeDb, rng);
        const open = await listReviewItems(nativeDb, { caller, state: "open" });
        invariant(open.ok, "listing the queue failed");
        expect(open.value.truncated).toBe(false);
        const [item] = open.value.items;
        invariant(item !== undefined, "an item opened");
        expect(item.account.id).toBe(running.accountId);
        expect([item.risk, item.urgency]).toEqual([44, 50]);
        expect(item.signals.map((s) => [s.kind, s.sessions])).toEqual([["loader_silent", 2]]);

        const decide = () =>
            decideReviewItem(nativeDb, {
                caller,
                itemId: item.id,
                outcome: "no_action",
                note: "a flaky loader build",
            });
        expect(await decide()).toEqual({ ok: true, value: undefined });
        expect(await decide()).toEqual({ ok: false, error: { code: "ALREADY_DECIDED" } });
        const decided = await listReviewItems(nativeDb, { caller, state: "decided" });
        invariant(decided.ok, "listing decided items failed");
        expect(decided.value.items.map((i) => i.decision?.outcome)).toEqual(["no_action"]);
        const audited = await scalar(
            nativeDb,
            z.coerce.number(),
            sql`select count(*) as value from audit
                where operation = 'review.decide' and target->>'accountId' = ${running.accountId}`,
        );
        expect(audited).toBe(1);

        // Evidence before the decision doesn't reopen it.
        const backfill = await execute(
            nativeDb,
            sql`update risk_scoring_cursor set scored_through = '-infinity'`,
        );
        invariant(backfill.ok, "rewinding the cursor failed");
        expect(await scoreRisk(nativeDb)).toEqual({ ok: true, value: { changed: 0, failed: 0 } });
    });
});

test("the review queue takes risk:review, and the power to suspend does not open it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_906);
        const memberId = await seedAccount(nativeDb, rng, "nobody@lucent.test");
        const suspenderId = await seedAccount(nativeDb, rng, "suspender@lucent.test");
        const triageId = await seedAccount(nativeDb, rng, "triage@lucent.test");
        await grantRole(nativeDb, {
            accountId: suspenderId,
            roleId: await seedRole(nativeDb, {
                id: "role_suspender",
                rank: 2,
                permissions: ["accounts:suspend"],
            }),
        });
        await grantRole(nativeDb, {
            accountId: triageId,
            roleId: await seedRole(nativeDb, {
                id: "role_triage",
                rank: 1,
                permissions: ["risk:review"],
            }),
        });
        for (const accountId of [memberId, suspenderId]) {
            expect(
                await listReviewItems(nativeDb, {
                    caller: await steppedUp(nativeDb, accountId),
                    state: "open",
                }),
            ).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        }
        const triaged = await listReviewItems(nativeDb, {
            caller: await steppedUp(nativeDb, triageId),
            state: "open",
        });
        expect(triaged.ok).toBe(true);
    });
});

test("retention removes renewals past 90 days and signals past a year, and keeps the rest", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_907);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, {
            email: "old@lucent.test",
            reported: [GAME],
        });
        await renew(running);
        await renew(running);
        await renew(running);
        const aged = await execute(
            nativeDb,
            sql`update lease_renewal set received_at = now() - interval '91 days'
                where sequence = 2`,
        );
        invariant(aged.ok, "ageing a renewal failed");
        const old = await execute(
            nativeDb,
            sql`insert into risk_signal (account_id, kind, observed_at)
                values (${running.accountId}, 'loader_silent', now() - interval '366 days'),
                       (${running.accountId}, 'loader_silent', now() - interval '364 days')`,
        );
        invariant(old.ok, "adding old signals failed");

        expect(await sweepRetention(nativeDb)).toEqual({ ok: true, value: 2 });
        const renewals = await scalar(
            nativeDb,
            z.coerce.number(),
            sql`select count(*) as value from lease_renewal`,
        );
        expect(renewals).toBe(2);
        const kept = await scalar(
            nativeDb,
            z.coerce.number(),
            sql`select count(*) as value from risk_signal`,
        );
        expect(kept).toBe(3);
        expect(await sweepRetention(nativeDb)).toEqual({ ok: true, value: 0 });
    });
});

test("staff can't decide a review item about their own account", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_908);
        const rootId = await seedRootOnce(nativeDb, rng);
        const caller = await steppedUp(nativeDb, rootId);
        const item = await queryOne(
            nativeDb,
            z.object({ id: z.string() }),
            sql`insert into review_item
                    (account_id, risk_score, urgency_score, signals, opened_at, scored_at)
                values (${rootId}, 44, 50, '[]'::jsonb, now(), now()) returning id::text as id`,
        );
        invariant(item.ok && item.value !== null, "opening an item failed");
        const refused = await decideReviewItem(nativeDb, {
            caller,
            itemId: item.value.id,
            outcome: "no_action",
            note: null,
        });
        expect(refused).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
        const open = await scalar(
            nativeDb,
            z.coerce.number(),
            sql`select count(*) as value from review_item where decided_at is null`,
        );
        expect(open).toBe(1);
    });
});

test("an account that fails to score doesn't stop the others, and the cursor waits for it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_909);
        const failing = await seedAccount(nativeDb, rng, "failing@lucent.test");
        const scored = await seedAccount(nativeDb, rng, "scored@lucent.test");
        for (const account of [failing, scored]) {
            const added = await execute(
                nativeDb,
                sql`insert into risk_signal (account_id, kind, observed_at)
                    values (${account}, 'loader_silent', now()), (${account}, 'loader_silent', now())`,
            );
            invariant(added.ok, "adding signals failed");
        }
        // A database failure for one account's item, whichever order the accounts come in.
        const trapped = await execute(
            nativeDb,
            sql`create table trapped_account (id text primary key)`,
        );
        invariant(trapped.ok, "creating the trap table failed");
        const marked = await execute(
            nativeDb,
            sql`insert into trapped_account values (${failing})`,
        );
        invariant(marked.ok, "marking the account failed");
        const trap = await execute(
            nativeDb,
            sql`create function refuse_review_item() returns trigger language plpgsql as $$
                begin
                    if exists (select 1 from trapped_account where id = new.account_id) then
                        raise exception 'refused' using errcode = 'check_violation';
                    end if;
                    return new;
                end; $$`,
        );
        invariant(trap.ok, `creating the trap failed: ${JSON.stringify(trap)}`);
        const armed = await execute(
            nativeDb,
            sql`create trigger refuse_review_item before insert on review_item
                for each row execute function refuse_review_item()`,
        );
        invariant(armed.ok, "arming the trap failed");

        expect(await scoreRisk(nativeDb)).toEqual({ ok: true, value: { changed: 1, failed: 1 } });
        const through = await scalar(
            nativeDb,
            z.string(),
            sql`select scored_through::text as value from risk_scoring_cursor`,
        );
        expect(through).toBe("-infinity");

        const disarmed = await execute(
            nativeDb,
            sql`drop trigger refuse_review_item on review_item`,
        );
        invariant(disarmed.ok, "dropping the trap failed");
        expect(await scoreRisk(nativeDb)).toEqual({ ok: true, value: { changed: 1, failed: 0 } });
    });
});

test("a start reporting a build while a promotion covering it commits records the coverage", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_910);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "race@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(harness.rng));
        await signIn(harness, loader, member.browserSession);
        await enroll(harness, loader, member.browserSession);
        const setId = await stageSet(nativeDb, releases.module.id, [GAME], 1);

        // A promotion in flight, as promoteFactSet holds it: the coverage lock taken and the set
        // current, not yet committed.
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let locked = () => {};
        const lockTaken = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const promotion = withTx(nativeDb, async (tx) => {
            const coverage = await lockBuildCoverage(tx, { productId: "cs2", mode: "exclusive" });
            if (!coverage.ok) return coverage;
            const current = await execute(
                tx,
                sql`insert into current_fact_set
                        (release_id, name_hash, time_date_stamp, size_of_image, revision)
                    select release_id, name_hash, time_date_stamp, size_of_image, revision
                    from fact_set_build where set_id = ${setId}::bigint`,
            );
            if (!current.ok) return current;
            locked();
            await held;
            return ok(undefined);
        });
        await lockTaken;
        const started = startOk(loader, releases, [GAME]);
        // Long enough for the start to reach the lock; were it not waiting, it would finish here
        // and record the build uncovered.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const before = await scalar(
            nativeDb,
            z.coerce.number(),
            sql`select count(*) as value from module_build_seen`,
        );
        release();
        expect(before).toBe(0);
        expect((await promotion).ok).toBe(true);
        await started;

        const covered = await scalar(
            nativeDb,
            z.boolean(),
            sql`select first_covered_at is not null as value from module_build_seen`,
        );
        expect(covered).toBe(true);
    });
});
