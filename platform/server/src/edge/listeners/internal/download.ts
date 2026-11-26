import { join } from "node:path";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err } from "@lucent/core/result";
import { BearerToken } from "@lucent/core/scalars";
import { RPC_HEADERS } from "@lucent/rpc/contract";
import { LOADER_DOWNLOAD_PATH } from "@lucent/rpc/web";
import type { Hono } from "hono";
import type { Logger } from "../../../base/core/log.ts";
import type { Db } from "../../../base/db/pool.ts";
import { readLoaderOffer } from "../../../delivery/releases/offer.ts";

function refusal(code: string, status: 400 | 401 | 404 | 503): Response {
    return Response.json(err({ code }), { status, headers: { "cache-control": "no-store" } });
}

// One of the internal listener's streaming routes: the bytes go out as read from disk, never
// whole in memory. Web names the file and makes it an attachment; this serves what the member's
// session may have.
export function mountLoaderDownload(
    app: Hono,
    deps: {
        readonly db: Db;
        readonly catalog: ProductCatalog;
        // Null when the server runs without the loaders' listener, so nothing was published here.
        readonly artifactDir: string | null;
        readonly isSuperseded: () => boolean;
        readonly logger: Logger;
    },
): void {
    app.get(LOADER_DOWNLOAD_PATH, async (c) => {
        if (deps.isSuperseded()) return refusal("SERVICE_UNAVAILABLE", 503);
        const token = BearerToken.safeParse(c.req.header(RPC_HEADERS.session));
        if (!token.success) return refusal("INVALID_REQUEST", 400);
        const offer = await readLoaderOffer(deps.db, {
            catalog: deps.catalog,
            sessionToken: token.data,
        });
        if (!offer.ok) {
            return offer.error.code === "SESSION_INVALID"
                ? refusal("SESSION_INVALID", 401)
                : refusal("SERVICE_UNAVAILABLE", 503);
        }
        if (offer.value.state !== "ready") return refusal("NOT_FOUND", 404);
        const { digest } = offer.value;
        // Only a digest from a verified seal names a file; ops wrote it, never a request.
        const file = deps.artifactDir === null ? null : Bun.file(join(deps.artifactDir, digest));
        if (file === null || !(await file.exists())) {
            deps.logger.write("error", "artifact_missing", {
                origin: "internal-web",
                detail: `no file for the current loader ${digest}`,
            });
            return refusal("SERVICE_UNAVAILABLE", 503);
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
