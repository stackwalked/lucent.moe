import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { type BearerToken, toHex } from "@lucent/core/scalars";
import { digestOf, parseReleaseSeal } from "@lucent/wire/release-seal";
import type { Db, DbFailure } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { readSession, type SessionInvalid } from "../../identity/auth/sessions.ts";
import { readLoaderSeal } from "./loader.ts";

// The loader's first download, from the member area. Who may have it is GET /v1/loader's rule
// (loader.ts): an account entitled to any product other than the loader. Its bytes are
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
