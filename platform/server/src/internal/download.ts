import { join } from "node:path";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { BearerToken, toHex } from "@lucent/core/scalars";
import { RPC_HEADERS } from "@lucent/rpc/contract";
import { LOADER_DOWNLOAD_PATH } from "@lucent/rpc/web";
import { digestOf, parseReleaseSeal } from "@lucent/wire/release-seal";
import type { Hono } from "hono";
import { readSession, type SessionInvalid } from "../auth/sessions.ts";
import type { Logger } from "../core/log.ts";
import type { Db, DbFailure } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { readLoaderSeal } from "../native/loader.ts";

// The loader's first download, from the member area. Who may have it is GET /v1/loader's rule
// (native/loader.ts): an account entitled to any product other than the loader. Its bytes are
// the current loader seal's `loader` artifact, where `ops publish-loader` wrote it by digest.

export type LoaderOffer =
    | { readonly state: "ready"; readonly number: string; readonly digest: string }
    | { readonly state: "no_product" }
    | { readonly state: "no_release" };

export async function readLoaderOffer(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly sessionToken: BearerToken },
): Promise<Result<LoaderOffer, SessionInvalid | DbFailure>> {
    const session = await withTx(db, async (tx, txNow) =>
        readSession(tx, { token: params.sessionToken, txNow, purposes: ["member"] }),
    );
    if (!session.ok) return session;
    const seal = await readLoaderSeal(db, {
        catalog: params.catalog,
        accountId: session.value.accountId,
    });
    if (!seal.ok) {
        switch (seal.error.code) {
            case "ENTITLEMENT_INACTIVE":
                return ok({ state: "no_product" });
            case "RELEASE_UNAVAILABLE":
            case "NOT_FOUND":
                return ok({ state: "no_release" });
            // Suspended since the session was read.
            case "ACCOUNT_SUSPENDED":
                return err({ code: "SESSION_INVALID" });
            default:
                return err(seal.error);
        }
    }
    const parsed = parseReleaseSeal(seal.value);
    invariant(parsed.ok, "a stored loader seal was verified when it was published");
    const digest = digestOf(parsed.value, "loader");
    invariant(digest !== null, "a loader seal names its loader");
    return ok({ state: "ready", number: parsed.value.number.toString(), digest: toHex(digest) });
}

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
