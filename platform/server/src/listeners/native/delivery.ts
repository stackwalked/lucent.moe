import { join } from "node:path";
import type { Hono } from "hono";
import { checkLoaderArtifact, readLoaderSeal } from "../../releases/loader.ts";
import { binaryResponse, refusalResponse } from "./http.ts";
import { refusalOf, reply } from "./responses.ts";
import type { NativeRoutes } from "./route-context.ts";

export function mountDelivery(app: Hono, { deps, authenticated, unavailable }: NativeRoutes): void {
    app.get("/v1/loader", async (c) => {
        const caller = await authenticated(c, "loader.seal");
        if (!caller.ok) return refusalResponse(caller.error);
        const seal = await readLoaderSeal(deps.db, {
            catalog: deps.catalog,
            accountId: caller.value.holder.accountId,
        });
        return reply(seal, (bytes) => binaryResponse(new Uint8Array(bytes)));
    });

    app.get("/v1/artifacts/:digest", async (c) => {
        const caller = await authenticated(c, "artifacts.read");
        if (!caller.ok) return refusalResponse(caller.error);
        const digest = c.req.param("digest");
        if (!/^[0-9a-f]{64}$/.test(digest)) return refusalResponse({ code: "NOT_FOUND" });
        const offered = await checkLoaderArtifact(deps.db, {
            catalog: deps.catalog,
            accountId: caller.value.holder.accountId,
            digest,
        });
        if (!offered.ok) return refusalResponse(refusalOf(offered.error));
        // Only the validated digest names a file; the bytes were written by ops, never by a request.
        const file = Bun.file(join(deps.artifactDir, digest));
        if (!(await file.exists())) {
            return await unavailable(
                `no file for the current artifact ${digest}`,
                "artifact_missing",
            );
        }
        return new Response(file.stream(), {
            headers: {
                "content-type": "application/octet-stream",
                "content-length": String(file.size),
                "cache-control": "no-store",
            },
        });
    });
}
