import { expect, test } from "bun:test";
import { join } from "node:path";
import { blake2b256 } from "@lucent/bundle/crypto";
import {
    toReleaseManifestV3Bytes,
    toReleaseManifestV4Bytes,
} from "@lucent/bundle/release-manifest";
import { createWriter, equalBytes } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { writeContext } from "@lucent/wire/codec";
import { toContainerBodyBytes, unpackContainer } from "@lucent/wire/container";
import {
    digestOf,
    parseReleaseSeal,
    type ReleaseArtifact,
    type ReleaseSeal,
    toReleaseSealBytes,
    toReleaseSealSignedBytes,
} from "@lucent/wire/release-seal";
import { signWithSeed } from "@lucent/wire/session-crypto";
import { type Channel, parseStartReply } from "@lucent/wire/start";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { publishLoaderRelease, publishModuleRelease } from "../src/delivery/releases/publish.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    decryptContainer,
    enroll,
    entitledMember,
    refusalCodeOf,
    signIn,
    startBody,
} from "./native-fixtures.ts";

// The code key is a test key (RFC 8032's third, as contracts/release-seal names it); the
// container is contracts/container/v1's small vector, a real packed container.

const CODE_SEED = Uint8Array.fromHex(
    "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
);
const OTHER_SEED = Uint8Array.fromHex(
    "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
);

// RFC 8032's third public key, CODE_SEED's.
const CODE_KEY = Uint8Array.fromHex(
    "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
);

const CONTAINER = new Uint8Array(
    await Bun.file(
        join(import.meta.dir, "..", "..", "..", "contracts", "container", "v1", "small.bin"),
    ).bytes(),
);
// The small container's release id and boot_info version.
const MODULE_RELEASE = new Uint8Array(16).fill(0x33);
const BOOT_INFO_VERSION = 3;

const MANIFEST = toReleaseManifestV3Bytes({
    product: "cs2",
    facts: [],
    capabilities: [],
    features: [{ key: 0x1111n, tag: "aim" }],
});

// LZ4's block format allows a block of literals alone: valid input to any decompressor, and all a
// test needs to pack a container without a compressor.
function literalBlock(body: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    out.u8(0xf0);
    let remaining = body.byteLength - 15;
    for (; remaining >= 255; remaining -= 255) out.u8(255);
    out.u8(remaining);
    out.bytes(body);
    return out.finish();
}

// The small vector's container, under another release id when asked.
function containerFor(release: Uint8Array): Uint8Array<ArrayBuffer> {
    if (equalBytes(release, MODULE_RELEASE)) return CONTAINER;
    const base = unpackContainer(CONTAINER);
    invariant(base.ok, "the small vector unpacks");
    const body = toContainerBodyBytes({ ...base.value, release });
    const block = literalBlock(body);
    const out = createWriter();
    writeContext(out, "container", 1);
    out.u32(body.byteLength);
    out.u32(block.byteLength);
    out.bytes(block);
    return out.finish();
}

async function signed(
    fields: Omit<ReleaseSeal, "signature">,
    seed: Uint8Array = CODE_SEED,
): Promise<Uint8Array<ArrayBuffer>> {
    const signature = await signWithSeed(seed, toReleaseSealSignedBytes(fields));
    return toReleaseSealBytes({ ...fields, signature });
}

function moduleArtifacts(container: Uint8Array, manifest: Uint8Array): ReleaseArtifact[] {
    return [
        { kind: "container", digest: blake2b256(container) },
        { kind: "release_manifest", digest: blake2b256(manifest) },
    ];
}

async function moduleSeal(params: {
    readonly number: bigint;
    readonly channel?: Channel;
    readonly release?: Uint8Array;
    readonly seed?: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
    return await signed(
        {
            product: "cs2",
            channel: params.channel ?? "alpha",
            number: params.number,
            release: params.release ?? MODULE_RELEASE,
            bootInfoVersion: BOOT_INFO_VERSION,
            artifacts: moduleArtifacts(containerFor(params.release ?? MODULE_RELEASE), MANIFEST),
        },
        params.seed,
    );
}

async function publishModule(db: Db, seal: Uint8Array, container: Uint8Array = CONTAINER) {
    return await publishModuleRelease(db, {
        codeKey: CODE_KEY,
        artifacts: { seal, container, manifest: MANIFEST },
    });
}

const LOADER = new TextEncoder().encode("a loader executable");
const HOST = new TextEncoder().encode("lucent-host's executable");

async function publishLoader(
    db: Db,
    params: {
        readonly number: bigint;
        readonly release: Uint8Array;
        readonly channel?: Channel;
    },
) {
    const seal = await signed({
        product: "lucent-loader",
        channel: params.channel ?? "stable",
        number: params.number,
        release: params.release,
        bootInfoVersion: BOOT_INFO_VERSION,
        artifacts: [
            { kind: "loader", digest: blake2b256(LOADER) },
            { kind: "host", digest: blake2b256(HOST) },
        ],
    });
    return {
        seal,
        published: await publishLoaderRelease(db, {
            codeKey: CODE_KEY,
            artifacts: { seal, loader: LOADER, host: HOST },
        }),
    };
}

test("a module release verified under the code key is stored staged, not promoted", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const seal = await moduleSeal({ number: 1n });

        const published = await publishModule(nativeDb, seal);

        expect(published).toEqual({
            ok: true,
            value: { release: MODULE_RELEASE, product: "cs2", channel: "alpha", number: 1n },
        });
        const rows = await queryAll(
            nativeDb,
            z.object({ seal: z.instanceof(Uint8Array), container: z.instanceof(Uint8Array) }),
            sql`select s.seal, r.container from release_seal s join release r on r.id = s.release_id
                where s.product_id = 'cs2' and s.channel = 'alpha' and s.number = 1`,
        );
        expect(rows.ok && rows.value).toEqual([{ seal, container: CONTAINER }]);
        const promoted = await queryAll(
            nativeDb,
            z.object({ number: z.string() }),
            sql`select number from current_release`,
        );
        expect(promoted.ok && promoted.value).toEqual([]);
    });
});

test("a module release keeps the data response version its manifest names: 3 from version 4, 2 from version 3", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const v4Release = new Uint8Array(16).fill(0x34);
        const v4Manifest = toReleaseManifestV4Bytes({
            product: "cs2",
            facts: [],
            capabilities: [],
            features: [{ key: 0x1111n, tag: "aim" }],
            dataResponse: 3,
        });
        const v4Container = containerFor(v4Release);
        const v4Seal = await signed({
            product: "cs2",
            channel: "alpha",
            number: 2n,
            release: v4Release,
            bootInfoVersion: BOOT_INFO_VERSION,
            artifacts: moduleArtifacts(v4Container, v4Manifest),
        });

        expect((await publishModule(nativeDb, await moduleSeal({ number: 1n }))).ok).toBe(true);
        const published = await publishModuleRelease(nativeDb, {
            codeKey: CODE_KEY,
            artifacts: { seal: v4Seal, container: v4Container, manifest: v4Manifest },
        });
        expect(published.ok).toBe(true);
        const rows = await queryAll(
            nativeDb,
            z.object({ number: z.string(), data_response: z.coerce.number() }),
            sql`select s.number::text as number, r.data_response
                from release_seal s join release r on r.id = s.release_id order by s.number`,
        );
        expect(rows.ok && rows.value).toEqual([
            { number: "1", data_response: 2 },
            { number: "2", data_response: 3 },
        ]);
    });
});

test("a release numbered at or below the highest signed for its product and channel is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const second = new Uint8Array(16).fill(0x34);
        const third = new Uint8Array(16).fill(0x35);

        expect((await publishModule(nativeDb, await moduleSeal({ number: 5n }))).ok).toBe(true);
        const same = await publishModule(
            nativeDb,
            await moduleSeal({ number: 5n, release: second }),
            containerFor(second),
        );
        const lower = await publishModule(
            nativeDb,
            await moduleSeal({ number: 4n, release: second }),
            containerFor(second),
        );
        const otherChannel = await publishModule(
            nativeDb,
            await moduleSeal({ number: 1n, release: third, channel: "stable" }),
            containerFor(third),
        );
        const higher = await publishModule(
            nativeDb,
            await moduleSeal({ number: 6n, release: second }),
            containerFor(second),
        );

        expect(same).toEqual({ ok: false, error: { code: "NUMBER_NOT_ABOVE", highest: 5n } });
        expect(lower).toEqual({ ok: false, error: { code: "NUMBER_NOT_ABOVE", highest: 5n } });
        expect(otherChannel.ok).toBe(true);
        expect(higher.ok).toBe(true);
    });
});

test("going back is the same release under a higher number; another under its id is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const second = new Uint8Array(16).fill(0x34);

        const first = await publishModule(nativeDb, await moduleSeal({ number: 1n }));
        const forward = await publishModule(
            nativeDb,
            await moduleSeal({ number: 2n, release: second }),
            containerFor(second),
        );
        const back = await publishModule(nativeDb, await moduleSeal({ number: 3n }));
        const otherManifest = toReleaseManifestV3Bytes({
            product: "cs2",
            facts: [],
            capabilities: [],
            features: [],
        });
        const differing = await publishModuleRelease(nativeDb, {
            codeKey: CODE_KEY,
            artifacts: {
                seal: await signed({
                    product: "cs2",
                    channel: "alpha",
                    number: 4n,
                    release: MODULE_RELEASE,
                    bootInfoVersion: BOOT_INFO_VERSION,
                    artifacts: moduleArtifacts(CONTAINER, otherManifest),
                }),
                container: CONTAINER,
                manifest: otherManifest,
            },
        });

        expect([first.ok, forward.ok, back.ok]).toEqual([true, true, true]);
        expect(differing).toEqual({ ok: false, error: { code: "RELEASE_DIFFERS" } });
        const seals = await queryAll(
            nativeDb,
            z.object({ number: z.string(), release_id: z.instanceof(Uint8Array) }),
            sql`select number, release_id from release_seal order by number`,
        );
        expect(seals.ok && seals.value).toEqual([
            { number: "1", release_id: MODULE_RELEASE },
            { number: "2", release_id: second },
            { number: "3", release_id: MODULE_RELEASE },
        ]);
    });
});

test("a seal another key signed, or artifacts its digests don't name, are refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const otherKey = await publishModule(
            nativeDb,
            await moduleSeal({ number: 1n, seed: OTHER_SEED }),
        );
        const changed = new Uint8Array(CONTAINER);
        changed[CONTAINER.byteLength - 1] = (changed[CONTAINER.byteLength - 1] ?? 0) ^ 1;
        const wrongContainer = await publishModule(
            nativeDb,
            await moduleSeal({ number: 1n }),
            changed,
        );

        expect(otherKey).toEqual({ ok: false, error: { code: "SEAL_UNSIGNED" } });
        expect(wrongContainer).toEqual({
            ok: false,
            error: { code: "DIGEST_MISMATCH", artifact: "container" },
        });
    });
});

test("a seal naming another release id than its container's is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        // Signed over the small container's digest, naming a release id it doesn't carry.
        const seal = await signed({
            product: "cs2",
            channel: "alpha",
            number: 1n,
            release: new Uint8Array(16).fill(0x99),
            bootInfoVersion: BOOT_INFO_VERSION,
            artifacts: moduleArtifacts(CONTAINER, MANIFEST),
        });

        expect(await publishModule(nativeDb, seal)).toEqual({
            ok: false,
            error: { code: "CONTAINER_DISAGREES", field: "release" },
        });
    });
});

test("a loader release is checked against its executables' digests and stored staged", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = new Uint8Array(16).fill(0x44);
        const { published } = await publishLoader(nativeDb, { number: 1n, release });
        const wrongHost = await publishLoaderRelease(nativeDb, {
            codeKey: CODE_KEY,
            artifacts: {
                seal: (await publishLoader(nativeDb, { number: 2n, release })).seal,
                loader: LOADER,
                host: LOADER,
            },
        });

        expect(published.ok).toBe(true);
        expect(wrongHost).toEqual({
            ok: false,
            error: { code: "DIGEST_MISMATCH", artifact: "host" },
        });
    });
});

test("a loader seal signed for any channel but stable is refused and stores nothing", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = new Uint8Array(16).fill(0x45);
        const { published } = await publishLoader(nativeDb, {
            number: 1n,
            release,
            channel: "alpha",
        });
        const stored = await queryAll(
            nativeDb,
            z.object({ n: z.coerce.number() }),
            sql`select count(*) as n from release_seal where product_id = 'lucent-loader'`,
        );

        expect(published).toEqual({ ok: false, error: { code: "LOADER_CHANNEL_INVALID" } });
        expect(stored).toEqual({ ok: true, value: [{ n: 0 }] });
    });
});

test("once promoted, a start serves the published container and seal, whose digest it matches", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_301);
        const harness = await createNativeHarness(nativeDb, rng);
        const loaderRelease = new Uint8Array(16).fill(0x44);
        expect(
            (await publishLoader(nativeDb, { number: 1n, release: loaderRelease })).published.ok,
        ).toBe(true);
        const seal = await moduleSeal({ number: 1n });
        expect((await publishModule(nativeDb, seal)).ok).toBe(true);
        // Web's promotion, as it will write it.
        for (const [product, channel] of [
            ["lucent-loader", "stable"],
            ["cs2", "alpha"],
        ]) {
            const promoted = await execute(
                nativeDb,
                sql`insert into current_release (product_id, channel, number)
                    values (${product}, ${channel}, 1)`,
            );
            invariant(promoted.ok, "promoting failed");
        }
        const member = await entitledMember(harness, {
            email: "ship@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(harness.rng));
        await signIn(harness, loader, member.browserSession);
        await enroll(harness, loader, member.browserSession);

        const sent = await loader.send({
            method: "POST",
            path: "/v1/starts",
            body: startBody({ loaderRelease }),
        });
        const reply = parseStartReply(sent.bytes);
        invariant(reply.ok, `the start was refused: ${refusalCodeOf(sent)}`);
        const downloaded = await loader.send({
            method: "GET",
            path: `/v1/starts/${reply.value.start.toHex()}/container`,
        });
        const container = decryptContainer(reply.value.containerKey, downloaded.bytes);

        expect(reply.value.releaseSeal).toEqual(seal);
        expect(container).toEqual(CONTAINER);
        const opened = parseReleaseSeal(reply.value.releaseSeal);
        expect(opened.ok && digestOf(opened.value, "container")).toEqual(blake2b256(CONTAINER));
    });
});
