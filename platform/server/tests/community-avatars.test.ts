import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import type { BearerToken } from "@lucent/core/scalars";
import { RPC_HEADERS } from "@lucent/rpc/contract";
import { AVATAR_IMAGE_PATH, AVATAR_UPLOAD_PATH } from "@lucent/rpc/web";
import { z } from "zod";
import { clearAvatar, setAvatar, toAvatarDigest } from "../src/community/avatars.ts";
import { setBlock } from "../src/community/blocks.ts";
import { exportOwnData } from "../src/community/export.ts";
import { readProfile, setBio, setVisibility } from "../src/community/profiles.ts";
import { createShout, listShouts } from "../src/community/shouts.ts";
import { claimServiceEpoch, openEpochGuard } from "../src/db/epoch-guard.ts";
import { type Db, queryAll, sql } from "../src/db/pool.ts";
import { createInternalWebApp } from "../src/listeners/internal/app.ts";
import { createReport, listReports, resolveReport } from "../src/moderation/reports.ts";
import { setRestriction } from "../src/moderation/restrictions.ts";
import { catalog } from "./authority-fixtures.ts";
import { member, moderator, NO_LOG } from "./community-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const products = catalog();
const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
const FIXTURES = new URL("./fixtures/image/", import.meta.url);

function fixture(name: string): Promise<Uint8Array<ArrayBuffer>> {
    return Bun.file(Bun.fileURLToPath(new URL(name, FIXTURES))).bytes();
}

// Stand-ins for what the decoder child returns: the writer stores bytes by their digest and never
// looks inside them, so the child need not run where storage is what's under test.
function images(seed: string) {
    const bytes = (size: string) => new TextEncoder().encode(`RIFF${seed}${size}WEBP`);
    return { large: bytes("256"), small: bytes("64") };
}

async function storedDigests(db: Db): Promise<string[]> {
    const rows = await queryAll(
        db,
        z.object({ digest: z.string() }),
        sql`select digest from avatar_image order by digest`,
    );
    invariant(rows.ok, "expected the images");
    return rows.value.map((row) => row.digest);
}

async function internalApp(db: Db, seed: number) {
    const auth = await createTestAuthDeps(db, createSeededRng(seed));
    const claimed = await claimServiceEpoch(db);
    invariant(claimed.ok, "epoch claimed");
    const guard = openEpochGuard({
        db,
        ownEpoch: claimed.value,
        pollIntervalMs: 60_000,
        onReadFailure: () => {},
    });
    const app = createInternalWebApp({
        catalog: products,
        auth,
        epochGuard: guard,
        webInternalKey: PEER_KEY,
        artifactDir: null,
        logger: NO_LOG,
    });
    const upload = (
        session: BearerToken,
        body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
        length: number,
    ) =>
        app.fetch(
            new Request(`http://localhost${AVATAR_UPLOAD_PATH}`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${PEER_KEY}`,
                    [RPC_HEADERS.session]: session,
                    "content-length": String(length),
                },
                body,
            }),
        );
    const image = (session: BearerToken, digest: string) =>
        app.fetch(
            new Request(`http://localhost${AVATAR_IMAGE_PATH}/${digest}`, {
                headers: { authorization: `Bearer ${PEER_KEY}`, [RPC_HEADERS.session]: session },
            }),
        );
    return { upload, image };
}

test("an uploaded avatar shows on the profile and beside what its owner wrote, and serves as a WebP cached for good", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(9501);
        const { upload, image } = await internalApp(db, 9502);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");

        const jpeg = await fixture("metadata.jpg");
        const answer = await upload(alice.token, jpeg, jpeg.length);
        expect(answer.status).toBe(200);
        const parsed = z
            .object({
                ok: z.literal(true),
                value: z.object({ large: z.string(), small: z.string() }),
            })
            .parse(await answer.json());
        const digests = parsed.value;

        const seen = await readProfile(db, bob.token, { username: "alice" });
        invariant(seen.ok, "expected the profile");
        expect(seen.value.avatar).toEqual(digests);
        expect(
            await createShout(db, alice.token, { catalog: products, productId: null, body: "hi" }),
        ).toMatchObject({ ok: true });
        const feed = await listShouts(db, bob.token, {
            catalog: products,
            productId: null,
            cursor: null,
        });
        invariant(feed.ok, "expected the feed");
        expect(feed.value.items[0]?.author).toEqual({ username: "alice", avatar: digests.small });

        const served = await image(bob.token, digests.large);
        expect(served.status).toBe(200);
        expect(served.headers.get("content-type")).toBe("image/webp");
        expect(served.headers.get("x-content-type-options")).toBe("nosniff");
        expect(served.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
        const bytes = new Uint8Array(await served.arrayBuffer());
        expect(toAvatarDigest(bytes)).toBe(digests.large);
        expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WEBP");

        // The export names the images and carries none of their bytes.
        const exported = await exportOwnData(db, alice.token);
        invariant(exported.ok, "expected the export");
        expect(exported.value.profile?.avatar).toEqual(digests);
    });
});

test("an upload that isn't an image, or says it's too large, is refused and stores nothing", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(9511);
        const { upload } = await internalApp(db, 9512);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const text = await fixture("not-an-image.png");
        const notImage = await upload(alice.token, text, text.length);
        expect(notImage.status).toBe(422);
        expect(await notImage.json()).toEqual(err({ code: "NOT_AN_IMAGE" }));
        const bomb = await fixture("bomb.png");
        expect(await (await upload(alice.token, bomb, bomb.length)).json()).toEqual(
            err({ code: "IMAGE_TOO_LARGE" }),
        );
        const tooLong = await upload(alice.token, new Uint8Array(16), 512 * 1024 + 1);
        expect(tooLong.status).toBe(413);
        expect(await storedDigests(db)).toEqual([]);
    });
});

test("a member barred everywhere is refused before a byte of the upload is read", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(9521);
        const { upload } = await internalApp(db, 9522);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const set = await setRestriction({
            db,
            catalog: products,
            caller: mod.caller,
            username: "alice",
            kind: "barred",
            productId: null,
            reason: "spam",
            endsAt: null,
        });
        invariant(set.ok, "expected the bar");
        let pulled = false;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    pulled = true;
                    controller.close();
                },
            },
            { highWaterMark: 0 },
        );
        const refused = await upload(alice.token, body, 1_000);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual(
            err({ code: "POSTING_RESTRICTED", kind: "barred", productId: null, endsAt: null }),
        );
        expect(pulled).toBe(false);
        // Taking a picture down is not posting.
        expect(await clearAvatar(db, alice.token)).toEqual(ok(undefined));
    });
});

test("replacing or clearing an avatar deletes the images no profile names any more, and keeps a shared one", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(9531);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const first = await setAvatar(db, alice.token, images("one"));
        invariant(first.ok, "expected the first avatar");
        const shared = await setAvatar(db, bob.token, images("one"));
        expect(shared).toEqual(first);
        const second = await setAvatar(db, alice.token, images("two"));
        invariant(second.ok, "expected the second avatar");
        // Bob still names the first pair.
        expect(await storedDigests(db)).toEqual(
            [first.value.large, first.value.small, second.value.large, second.value.small].sort(),
        );
        expect(await clearAvatar(db, bob.token)).toEqual(ok(undefined));
        expect(await storedDigests(db)).toEqual([second.value.large, second.value.small].sort());
        expect(await clearAvatar(db, alice.token)).toEqual(ok(undefined));
        expect(await storedDigests(db)).toEqual([]);
        const profile = await readProfile(db, alice.token, { username: "alice" });
        invariant(profile.ok, "expected the profile");
        expect(profile.value.avatar).toBeNull();
    });
});

test("a private profile's avatar is neither shown nor served to anyone but its owner, nor across a block", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(9541);
        const { image } = await internalApp(db, 9542);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const carol = await member(db, rng, "carol@lucent.test", "carol");
        const set = await setAvatar(db, alice.token, images("private"));
        invariant(set.ok, "expected the avatar");
        expect(
            await createShout(db, alice.token, { catalog: products, productId: null, body: "hi" }),
        ).toMatchObject({ ok: true });
        expect((await image(bob.token, set.value.small)).status).toBe(200);

        expect(await setBlock(db, carol.token, { username: "alice", blocked: true })).toEqual(
            ok(undefined),
        );
        expect((await image(carol.token, set.value.small)).status).toBe(404);

        expect(await setVisibility(db, alice.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        expect((await image(bob.token, set.value.small)).status).toBe(404);
        expect((await image(bob.token, set.value.large)).status).toBe(404);
        expect((await image(alice.token, set.value.large)).status).toBe(200);
        const feed = await listShouts(db, bob.token, {
            catalog: products,
            productId: null,
            cursor: null,
        });
        invariant(feed.ok, "expected the feed");
        expect(feed.value.items[0]?.author).toEqual({ username: "alice", avatar: null });
        const own = await listShouts(db, alice.token, {
            catalog: products,
            productId: null,
            cursor: null,
        });
        invariant(own.ok, "expected the feed");
        expect(own.value.items[0]?.author.avatar).toBe(set.value.small);
        // A digest no profile names is no image at all.
        expect((await image(alice.token, "0".repeat(64))).status).toBe(404);
    });
});

test("staff removing a profile take its avatar down and delete its images; a new bio lets a new one in", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        const rng = createSeededRng(9551);
        const mod = await moderator(db, rng, "mod@lucent.test");
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const set = await setAvatar(db, alice.token, images("rude"));
        invariant(set.ok, "expected the avatar");
        // A profile with a picture and no bio can still be reported.
        const profile = await readProfile(db, bob.token, { username: "alice" });
        invariant(profile.ok && profile.value.id !== null, "expected the profile row");
        expect(
            await createReport(db, bob.token, {
                catalog: products,
                kind: "profile",
                targetId: profile.value.id,
                reason: "abuse",
                note: "",
            }),
        ).toEqual(ok(undefined));
        const queue = await listReports(db, { caller: mod.caller, cursor: null });
        invariant(queue.ok && queue.value.items[0] !== undefined, "expected the report");
        const resolved = await resolveReport({
            db,
            caller: mod.caller,
            id: queue.value.items[0].id,
            outcome: "remove",
        });
        expect(resolved).toEqual(ok({ removed: { kind: "profile", id: profile.value.id } }));
        expect(await storedDigests(db)).toEqual([]);
        const after = await readProfile(db, bob.token, { username: "alice" });
        invariant(after.ok, "expected the profile");
        expect(after.value.avatar).toBeNull();

        expect(await setAvatar(db, alice.token, images("again"))).toEqual(
            err({ code: "PROFILE_REMOVED" }),
        );
        expect(await setBio(db, alice.token, { bio: "sorry" })).toEqual(ok(undefined));
        expect((await setAvatar(db, alice.token, images("again"))).ok).toBe(true);
    });
});
