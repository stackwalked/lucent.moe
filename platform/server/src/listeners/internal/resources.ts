import type { ProductCatalog } from "@lucent/catalog/catalog";
import { trySync } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { BearerToken, ClientInfo } from "@lucent/core/scalars";
import { RPC_HEADERS } from "@lucent/rpc/contract";
import { RESOURCE_DOWNLOAD_PATH, RESOURCE_UPLOAD_PATH } from "@lucent/rpc/web";
import type { Hono } from "hono";
import { z } from "zod";
import type { AuthDeps } from "../../auth/deps.ts";
import { resolveCaller } from "../../auth/viewer.ts";
import type { Logger } from "../../core/log.ts";
import {
    openResourceFile,
    RESOURCE_MAX_BYTES,
    storeResourceFile,
} from "../../support/resource-files.ts";
import {
    authorizeResourceUpload,
    readMemberResource,
    recordResourceUpload,
} from "../../support/resources.ts";

type Status = 400 | 401 | 403 | 404 | 413 | 503;

function reply(body: unknown, status: 200 | Status): Response {
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function refusal(error: { readonly code: string }, status: Status): Response {
    return reply(err(error), status);
}

// Who web says the browser is; a header that won't parse is no client, as for any RPC without one.
function clientOf(header: string | undefined): ClientInfo | null {
    if (header === undefined) return null;
    const decoded = trySync(
        (): unknown =>
            JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                    Uint8Array.fromBase64(header, { alphabet: "base64url" }),
                ),
            ),
        () => null,
    );
    if (!decoded.ok) return null;
    const parsed = ClientInfo.safeParse(decoded.value);
    return parsed.success ? parsed.data : null;
}

// The internal listener's streaming routes for resources: bytes in from staff and out to members,
// never whole in memory. Behind the mount's peer-key check like everything else on it.
//
// Upload: a POST of the raw bytes with `Lucent-Session` (staff, releases:promote) and a
// Content-Length of at most 64 MiB, answered `{ digest, size }`; publishing them is the
// `admin.resources.publish` procedure. Download: a GET of `<path>/<resource id>` with the
// member's `Lucent-Session`, answered with the bytes and the file's name, URI-encoded, in
// `Lucent-File-Name`.
export function mountResourceFiles(
    app: Hono,
    deps: {
        readonly auth: AuthDeps;
        readonly catalog: ProductCatalog;
        // Null without the loaders' listener: there is nowhere to keep the bytes.
        readonly artifactDir: string | null;
        readonly isSuperseded: () => boolean;
        readonly logger: Logger;
    },
): void {
    app.post(RESOURCE_UPLOAD_PATH, async (c) => {
        if (deps.isSuperseded()) return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        const token = BearerToken.safeParse(c.req.header(RPC_HEADERS.session));
        if (!token.success) return refusal({ code: "INVALID_REQUEST" }, 400);
        const length = Number(c.req.header("content-length") ?? "");
        if (!Number.isSafeInteger(length) || length <= 0) {
            return refusal({ code: "INVALID_REQUEST" }, 400);
        }
        if (length > RESOURCE_MAX_BYTES) return refusal({ code: "PAYLOAD_TOO_LARGE" }, 413);
        const caller = await resolveCaller(deps.auth.db, {
            sessionToken: token.data,
            client: clientOf(c.req.header(RPC_HEADERS.client)),
            stepUpWaived: deps.auth.passwordOnly === true,
        });
        if (!caller.ok) {
            return caller.error.code === "SESSION_INVALID"
                ? refusal(caller.error, 401)
                : refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        }
        const authorized = await authorizeResourceUpload(deps.auth.db, { caller: caller.value });
        if (!authorized.ok) {
            const { error } = authorized;
            if (error.code === "FORBIDDEN" || error.code === "STEP_UP_REQUIRED") {
                return refusal(error, 403);
            }
            return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        }
        const body = c.req.raw.body;
        if (body === null) return refusal({ code: "INVALID_REQUEST" }, 400);
        if (deps.artifactDir === null) return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        const stored = await storeResourceFile({
            artifactDir: deps.artifactDir,
            body,
            rng: deps.auth.rng,
        });
        if (!stored.ok) {
            if (stored.error.code === "PAYLOAD_TOO_LARGE") return refusal(stored.error, 413);
            if (stored.error.code === "EMPTY_FILE") return refusal(stored.error, 400);
            deps.logger.write("error", "resource_store_failed", {
                origin: "internal-web",
                detail: stored.error.detail,
            });
            return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        }
        const recorded = await recordResourceUpload(deps.auth.db, {
            caller: caller.value,
            ...stored.value,
        });
        if (!recorded.ok) return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        return reply(ok(stored.value), 200);
    });

    app.get(`${RESOURCE_DOWNLOAD_PATH}/:resourceId`, async (c) => {
        if (deps.isSuperseded()) return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        const token = BearerToken.safeParse(c.req.header(RPC_HEADERS.session));
        const resourceId = z.uuid().safeParse(c.req.param("resourceId"));
        if (!token.success || !resourceId.success) return refusal({ code: "INVALID_REQUEST" }, 400);
        const resource = await readMemberResource(deps.auth.db, token.data, {
            catalog: deps.catalog,
            resourceId: resourceId.data,
        });
        if (!resource.ok) {
            if (resource.error.code === "SESSION_INVALID") return refusal(resource.error, 401);
            if (resource.error.code === "NOT_FOUND") return refusal(resource.error, 404);
            return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        }
        const file =
            deps.artifactDir === null
                ? null
                : openResourceFile(deps.artifactDir, resource.value.digest);
        if (file === null || !(await file.exists()) || file.size !== resource.value.size) {
            deps.logger.write("error", "artifact_missing", {
                origin: "internal-web",
                detail: `no whole file for resource ${resource.value.id}`,
            });
            return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        }
        return new Response(file.stream(), {
            headers: {
                "content-type": "application/octet-stream",
                "content-length": String(file.size),
                "cache-control": "no-store",
                "lucent-file-name": encodeURIComponent(resource.value.fileName),
            },
        });
    });
}
