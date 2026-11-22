import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import { type AccountId, type EpochMs, toHex } from "@lucent/core/scalars";
import { digestOf, parseReleaseSeal } from "@lucent/wire/release-seal";
import { readEffectiveProductAccess } from "../authority/entitlements.ts";
import type { Db, DbFailure, Tx } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { type AccountInactive, lockActiveAccount } from "./accounts.ts";
import { findCurrentRelease, LOADER_CHANNEL, LOADER_PRODUCT } from "./releases.ts";

// The loader updates itself from the seal it is served and the two artifacts that seal names.
// The loader has one release line, so both are offered to any account entitled now to a product
// (the same effective access a start is checked against): a start on any product needs the loader
// current.

type Code<C extends string> = { readonly code: C };

export type LoaderRefusal =
    | AccountInactive
    | Code<"NOT_FOUND" | "ENTITLEMENT_INACTIVE" | "RELEASE_UNAVAILABLE">;

async function isEntitledToAProduct(
    tx: Tx,
    params: {
        readonly catalog: ProductCatalog;
        readonly accountId: AccountId;
        readonly txNow: EpochMs;
    },
): Promise<Result<boolean, DbFailure>> {
    for (const product of params.catalog.values()) {
        if (product.id === LOADER_PRODUCT) continue;
        const access = await readEffectiveProductAccess(tx, {
            accountId: params.accountId,
            product,
            at: params.txNow,
        });
        if (!access.ok) return access;
        if (access.value.isEntitled) return ok(true);
    }
    return ok(false);
}

// The current loader seal's bytes for an account entitled to a product.
export async function readLoaderSeal(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly accountId: AccountId },
): Promise<Result<Uint8Array, LoaderRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const account = await lockActiveAccount(tx, params.accountId, txNow);
        if (!account.ok) return account;
        const entitled = await isEntitledToAProduct(tx, { ...params, txNow });
        if (!entitled.ok) return entitled;
        if (!entitled.value) return err({ code: "ENTITLEMENT_INACTIVE" });
        const current = await findCurrentRelease(tx, {
            productId: LOADER_PRODUCT,
            channel: LOADER_CHANNEL,
        });
        if (!current.ok) return current;
        if (current.value === null) return err({ code: "RELEASE_UNAVAILABLE" });
        return ok(current.value.seal);
    });
}

// Whether the digest is the loader's or host's in the current loader seal, for an account
// entitled to a product. A replaced seal's artifacts are no longer offered, and nothing says
// whether a refused digest names a file.
export async function checkLoaderArtifact(
    db: Db,
    params: {
        readonly catalog: ProductCatalog;
        readonly accountId: AccountId;
        readonly digest: string;
    },
): Promise<Result<null, LoaderRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const account = await lockActiveAccount(tx, params.accountId, txNow);
        if (!account.ok) return account;
        const entitled = await isEntitledToAProduct(tx, { ...params, txNow });
        if (!entitled.ok) return entitled;
        if (!entitled.value) return err({ code: "NOT_FOUND" });
        const current = await findCurrentRelease(tx, {
            productId: LOADER_PRODUCT,
            channel: LOADER_CHANNEL,
        });
        if (!current.ok) return current;
        if (current.value === null) return err({ code: "NOT_FOUND" });
        const seal = parseReleaseSeal(current.value.seal);
        if (!seal.ok) return err({ code: "NOT_FOUND" });
        for (const kind of ["loader", "host"] as const) {
            const digest = digestOf(seal.value, kind);
            if (digest !== null && toHex(digest) === params.digest) return ok(null);
        }
        return err({ code: "NOT_FOUND" });
    });
}
