import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blake2b256 } from "@lucent/bundle/crypto";
import { invariant } from "@lucent/core/contain";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { toReleaseSealBytes } from "@lucent/wire/release-seal";
import { type Db, execute, sql } from "../src/db/pool.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    enroll,
    entitledMember,
    type NativeHarness,
    refusalCodeOf,
    signIn,
    type TestLoader,
} from "./native-fixtures.ts";

type PromotedLoader = {
    readonly seal: Uint8Array;
    readonly loader: Uint8Array;
    readonly host: Uint8Array;
};

// A loader release with a parseable seal (its signature isn't checked here; publishing does
// that), its two artifacts written under `artifactDir` by digest, promoted at once.
async function promoteLoader(
    db: Db,
    rng: SeededRng,
    params: { readonly number: bigint; readonly artifactDir: string },
): Promise<PromotedLoader> {
    const loader = rng.fillBytes(new Uint8Array(3_000));
    const host = rng.fillBytes(new Uint8Array(2_000));
    for (const bytes of [loader, host]) {
        await Bun.write(join(params.artifactDir, blake2b256(bytes).toHex()), bytes);
    }
    const release = rng.fillBytes(new Uint8Array(16));
    const seal = toReleaseSealBytes({
        product: "lucent-loader",
        channel: "stable",
        number: params.number,
        release,
        bootInfoVersion: 1,
        artifacts: [
            { kind: "loader", digest: blake2b256(loader) },
            { kind: "host", digest: blake2b256(host) },
        ],
        signature: new Uint8Array(64),
    });
    const stored = await execute(
        db,
        sql`insert into release (id, product_id, channel, container, manifest)
            values (${release}, 'lucent-loader', 'stable', null, null)`,
    );
    invariant(stored.ok, "inserting the release failed");
    const sealed = await execute(
        db,
        sql`insert into release_seal (product_id, channel, number, release_id, seal)
            values ('lucent-loader', 'stable', ${params.number}, ${release}, ${seal})`,
    );
    invariant(sealed.ok, "inserting the seal failed");
    const promoted = await execute(
        db,
        sql`insert into current_release (product_id, channel, number)
            values ('lucent-loader', 'stable', ${params.number})
            on conflict (product_id, channel) do update set number = excluded.number`,
    );
    invariant(promoted.ok, "promoting the release failed");
    return { seal, loader, host };
}

async function withLoaderServer(
    run: (setup: {
        readonly harness: NativeHarness;
        readonly rng: SeededRng;
        readonly db: Db;
        readonly artifactDir: string;
        readonly signedIn: (channels: readonly string[]) => Promise<TestLoader>;
    }) => Promise<void>,
): Promise<void> {
    const cluster = await sharedTestCluster();
    const artifactDir = await mkdtemp(join(tmpdir(), "lucent-artifacts-"));
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_601);
        const harness = await createNativeHarness(nativeDb, rng, { artifactDir });
        await run({
            harness,
            rng,
            db: nativeDb,
            artifactDir,
            signedIn: async (channels) => {
                const member = await entitledMember(harness, {
                    email: "loader@lucent.test",
                    channels,
                });
                const loader = createTestLoader(harness, await createTestDevice(rng));
                await signIn(harness, loader, member.browserSession);
                await enroll(harness, loader, member.browserSession);
                return loader;
            },
        });
    });
    await rm(artifactDir, { recursive: true, force: true });
}

const entitlementsEnded = sql`update entitlement set status = 'suspended'`;

test("the current loader seal is served to an account entitled to a product on any channel", async () => {
    await withLoaderServer(async ({ db, rng, artifactDir, signedIn }) => {
        const loader = await signedIn(["alpha"]);
        const released = await promoteLoader(db, rng, { number: 1n, artifactDir });
        const sent = await loader.send({ method: "GET", path: "/v1/loader" });
        expect(sent.status).toBe(200);
        expect(sent.bytes).toEqual(released.seal);
    });
});

test("the loader seal is refused to an account entitled to nothing now, even with a release promoted", async () => {
    await withLoaderServer(async ({ db, rng, artifactDir, signedIn }) => {
        const loader = await signedIn(["stable"]);
        await promoteLoader(db, rng, { number: 1n, artifactDir });
        await execute(db, entitlementsEnded);
        const sent = await loader.send({ method: "GET", path: "/v1/loader" });
        expect(sent.status).toBe(403);
        expect(refusalCodeOf(sent)).toBe("ENTITLEMENT_INACTIVE");
    });
});

test("the loader seal is unavailable while nothing is promoted", async () => {
    await withLoaderServer(async ({ signedIn }) => {
        const loader = await signedIn(["alpha"]);
        const none = await loader.send({ method: "GET", path: "/v1/loader" });
        expect(refusalCodeOf(none)).toBe("RELEASE_UNAVAILABLE");
    });
});

test("an artifact of the current loader seal streams with its exact bytes", async () => {
    await withLoaderServer(async ({ db, rng, artifactDir, signedIn }) => {
        const loader = await signedIn(["alpha"]);
        const released = await promoteLoader(db, rng, { number: 1n, artifactDir });
        for (const bytes of [released.loader, released.host]) {
            const path = `/v1/artifacts/${blake2b256(bytes).toHex()}`;
            const sent = await loader.send({ method: "GET", path });
            expect(sent.status).toBe(200);
            expect(sent.bytes).toEqual(bytes);
        }
    });
});

test("a digest outside the current seal is not found even when its file exists", async () => {
    await withLoaderServer(async ({ rng, artifactDir, signedIn }) => {
        const loader = await signedIn(["alpha"]);
        const stray = rng.fillBytes(new Uint8Array(500));
        const digest = blake2b256(stray).toHex();
        await Bun.write(join(artifactDir, digest), stray);
        const sent = await loader.send({ method: "GET", path: `/v1/artifacts/${digest}` });
        expect(sent.status).toBe(404);
        expect(refusalCodeOf(sent)).toBe("NOT_FOUND");
        const malformed = await loader.send({ method: "GET", path: "/v1/artifacts/..%2Fsecret" });
        expect(refusalCodeOf(malformed)).toBe("NOT_FOUND");
    });
});

test("the artifacts of a replaced loader seal are no longer served", async () => {
    await withLoaderServer(async ({ db, rng, artifactDir, signedIn }) => {
        const loader = await signedIn(["alpha"]);
        const first = await promoteLoader(db, rng, { number: 1n, artifactDir });
        const second = await promoteLoader(db, rng, { number: 2n, artifactDir });
        const old = await loader.send({
            method: "GET",
            path: `/v1/artifacts/${blake2b256(first.loader).toHex()}`,
        });
        expect(refusalCodeOf(old)).toBe("NOT_FOUND");
        const current = await loader.send({
            method: "GET",
            path: `/v1/artifacts/${blake2b256(second.loader).toHex()}`,
        });
        expect(current.bytes).toEqual(second.loader);
    });
});

test("the artifacts of the current loader seal are not found for an account entitled to nothing now", async () => {
    await withLoaderServer(async ({ db, rng, artifactDir, signedIn }) => {
        const loader = await signedIn(["stable"]);
        const released = await promoteLoader(db, rng, { number: 1n, artifactDir });
        await execute(db, entitlementsEnded);
        const sent = await loader.send({
            method: "GET",
            path: `/v1/artifacts/${blake2b256(released.host).toHex()}`,
        });
        expect(refusalCodeOf(sent)).toBe("NOT_FOUND");
    });
});

test("a current artifact whose file is missing is a server failure, not a not-found", async () => {
    await withLoaderServer(async ({ db, rng, artifactDir, signedIn }) => {
        const loader = await signedIn(["alpha"]);
        const released = await promoteLoader(db, rng, { number: 1n, artifactDir });
        await rm(join(artifactDir, blake2b256(released.loader).toHex()));
        const sent = await loader.send({
            method: "GET",
            path: `/v1/artifacts/${blake2b256(released.loader).toHex()}`,
        });
        expect(sent.status).toBe(503);
        expect(refusalCodeOf(sent)).toBe("SERVICE_UNAVAILABLE");
    });
});
