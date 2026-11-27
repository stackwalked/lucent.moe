import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { type BearerToken, toHex } from "@lucent/core/scalars";
import { digestOf, parseReleaseSeal } from "@lucent/wire/release-seal";
import { z } from "zod";
import { type Db, type DbFailure, queryOne, sql } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { readSession, type SessionInvalid } from "../../identity/auth/sessions.ts";
import { readLoaderSeal } from "./loader.ts";
import { LOADER_CHANNEL, LOADER_PRODUCT } from "./reads.ts";

// The loader's first download, from the member area. Who may have it is GET /v1/loader's rule
// (loader.ts): an account entitled to any product other than the loader. Its bytes are
// the current loader seal's `loader` artifact, where `ops publish-loader` wrote it by digest.

export type LoaderOffer =
    | {
          readonly state: "ready";
          readonly number: string;
          readonly digest: string;
          // The version of the changelog entry that names the seal's release, if one does.
          readonly version: string | null;
      }
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
    // Keyed by the seal just read, so the version is the one of that seal's release even if a
    // promotion lands in between.
    const named = await queryOne(
        db,
        z.object({ version: z.string() }),
        sql`select e.version from release_seal s
            join changelog_entry e on e.release_id = s.release_id
            where s.product_id = ${LOADER_PRODUCT} and s.channel = ${LOADER_CHANNEL}
              and s.number = ${parsed.value.number.toString()}::bigint`,
    );
    if (!named.ok) return named;
    return ok({
        state: "ready",
        number: parsed.value.number.toString(),
        digest: toHex(digest),
        version: named.value?.version ?? null,
    });
}
