import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import type { BearerToken } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { RPC_HEADERS } from "@lucent/rpc/contract";
import { RESOURCE_DOWNLOAD_PATH, RESOURCE_UPLOAD_PATH, webContract } from "@lucent/rpc/web";
import { hashToken } from "../src/auth/tokens.ts";
import { claimServiceEpoch, openEpochGuard } from "../src/db/epoch-guard.ts";
import { execute, sql } from "../src/db/pool.ts";
import { createInternalWebApp } from "../src/listeners/internal/app.ts";
import { RESOURCE_MAX_BYTES } from "../src/support/resource-files.ts";
import { catalog, grantRole, seedRole } from "./authority-fixtures.ts";
import { holdProduct, member, NO_LOG } from "./community-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";

// Bytes that differ at every offset a careless copy might shift or truncate.
function fileOf(size: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
    return bytes;
}

// More than the limit, a megabyte at a time, without holding it all.
function oversized(): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    return new ReadableStream({
        pull(controller) {
            if (sent > RESOURCE_MAX_BYTES) {
                controller.close();
                return;
            }
            sent += chunk.byteLength;
            controller.enqueue(chunk);
        },
    });
}

test("a resource uploads, lists for members entitled to its product and no one else, and downloads byte for byte", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const dir = await mkdtemp(join(tmpdir(), "lucent-resources-"));
        const rng = createSeededRng(831);
        const auth = await createTestAuthDeps(nativeDb, rng);
        const claimed = await claimServiceEpoch(nativeDb);
        invariant(claimed.ok, "epoch claimed");
        const guard = openEpochGuard({
            db: nativeDb,
            ownEpoch: claimed.value,
            pollIntervalMs: 60_000,
            onReadFailure: () => {},
        });
        const app = createInternalWebApp({
            catalog: catalog(),
            auth,
            epochGuard: guard,
            webInternalKey: PEER_KEY,
            artifactDir: dir,
            logger: NO_LOG,
        });
        const client = createRpcClient(webContract, {
            endpointUrl: "http://localhost/internal/web/rpc",
            peerKey: PEER_KEY,
            fetcher: async (req) => await app.fetch(req),
        });
        const upload = (
            session: BearerToken,
            body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
            length: number,
        ) =>
            app.fetch(
                new Request(`http://localhost${RESOURCE_UPLOAD_PATH}`, {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${PEER_KEY}`,
                        [RPC_HEADERS.session]: session,
                        "content-length": String(length),
                    },
                    body,
                }),
            );
        const download = (session: BearerToken, resourceId: string) =>
            app.fetch(
                new Request(`http://localhost${RESOURCE_DOWNLOAD_PATH}/${resourceId}`, {
                    headers: {
                        authorization: `Bearer ${PEER_KEY}`,
                        [RPC_HEADERS.session]: session,
                    },
                }),
            );

        const roleId = await seedRole(nativeDb, {
            id: "role_publisher",
            rank: 5,
            permissions: ["releases:promote"],
        });
        const staff = await member(nativeDb, rng, "staff@lucent.test");
        await grantRole(nativeDb, { accountId: staff.id, roleId });
        const holder = await member(nativeDb, rng, "holder@lucent.test");
        await holdProduct(nativeDb, rng, holder.id, "cs2");
        const stranger = await member(nativeDb, rng, "stranger@lucent.test");

        const bytes = fileOf(300_000);
        // Publishing is a release: no step-up, no upload.
        expect(await (await upload(staff.token, bytes, bytes.byteLength)).json()).toEqual(
            err({ code: "STEP_UP_REQUIRED", withinSeconds: 1_800 }),
        );
        expect(await (await upload(holder.token, bytes, bytes.byteLength)).json()).toEqual(
            err({ code: "FORBIDDEN" }),
        );
        await execute(
            nativeDb,
            sql`update browser_session set step_up_at = now()
                where token_hash = ${await hashToken(staff.token)}`,
        );
        const tooLarge = await upload(staff.token, oversized(), RESOURCE_MAX_BYTES);
        expect(tooLarge.status).toBe(413);
        const uploaded = await upload(staff.token, bytes, bytes.byteLength);
        expect(uploaded.status).toBe(200);
        const stored = await uploaded.json();
        invariant(
            typeof stored === "object" && stored !== null && "value" in stored,
            "upload answers a value",
        );
        const digest = new Bun.CryptoHasher("blake2b256").update(bytes).digest("hex");
        expect(stored.value).toEqual({ digest, size: bytes.byteLength });
        // Only the whole file is left, under its digest.
        expect(await readdir(dir)).toEqual([digest]);

        const published = await client.call(
            "admin.resources.publish",
            {
                digest,
                productId: "cs2",
                title: "config pack",
                description: "",
                fileName: "pack.zip",
            },
            { session: staff.token },
        );
        invariant(published.ok, `publish failed: ${JSON.stringify(published)}`);
        const { resourceId } = published.value;
        const everyone = await client.call(
            "admin.resources.publish",
            { digest, productId: null, title: "readme", description: "", fileName: "readme.txt" },
            { session: staff.token },
        );
        invariant(everyone.ok, "a resource for every member");

        const listed = async (session: BearerToken) => {
            const reply = await client.call("resources.list", {}, { session });
            invariant(reply.ok, "members list resources");
            return reply.value.items.map((item) => item.title);
        };
        expect(await listed(holder.token)).toEqual(["readme", "config pack"]);
        expect(await listed(stranger.token)).toEqual(["readme"]);

        const got = await download(holder.token, resourceId);
        expect(got.status).toBe(200);
        expect(got.headers.get("lucent-file-name")).toBe("pack.zip");
        expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
        const refused = await download(stranger.token, resourceId);
        expect(refused.status).toBe(404);
        await refused.body?.cancel();

        expect(
            await client.call("admin.resources.delete", { resourceId }, { session: holder.token }),
        ).toEqual(err({ code: "FORBIDDEN" }));
        expect(
            await client.call("admin.resources.delete", { resourceId }, { session: staff.token }),
        ).toEqual(ok({}));
        expect(await listed(holder.token)).toEqual(["readme"]);
        guard.close();
        await rm(dir, { recursive: true, force: true });
    });
});
