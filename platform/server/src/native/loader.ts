import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import { type AccountId, ChannelId, type EpochMs, ProductId, toHex } from "@lucent/core/scalars";
import { digestOf, parseReleaseSeal } from "@lucent/wire/release-seal";
import { readEffectiveProductAccess } from "../authority/entitlements.ts";
import type { Db, DbFailure, Tx } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { type AccountInactive, lockActiveAccount } from "./accounts.ts";
import { findCurrentRelease, LOADER_PRODUCT } from "./releases.ts";

// The loader updates itself from the seal it is served and the two artifacts that seal names.
// Both are offered only on channels the account holds: the channels of every product it is
// entitled to now (the same effective access a start is checked against), since a start on any
// product needs the loader current on that channel.

type Code<C extends string> = { readonly code: C };

export type LoaderRefusal =
    | AccountInactive
    | Code<"NOT_FOUND" | "CHANNEL_NOT_ALLOWED" | "RELEASE_UNAVAILABLE">;

async function heldChannels(
    tx: Tx,
    params: {
        readonly catalog: ProductCatalog;
        readonly accountId: AccountId;
        readonly txNow: EpochMs;
    },
): Promise<Result<ReadonlySet<ChannelId>, DbFailure>> {
    const held = new Set<ChannelId>();
    for (const product of params.catalog.values()) {
        const access = await readEffectiveProductAccess(tx, {
            accountId: params.accountId,
            product,
            at: params.txNow,
        });
        if (!access.ok) return access;
        if (!access.value.isEntitled) continue;
        for (const channel of access.value.channels) held.add(channel);
    }
    return ok(held);
}

// The current loader seal's bytes for a channel the account holds.
export async function readLoaderSeal(
    db: Db,
    params: {
        readonly catalog: ProductCatalog;
        readonly accountId: AccountId;
        readonly channel: string;
    },
): Promise<Result<Uint8Array, LoaderRefusal | DbFailure>> {
    const channel = ChannelId.safeParse(params.channel);
    const declared = params.catalog.get(ProductId.parse(LOADER_PRODUCT))?.channels ?? [];
    if (!channel.success || !declared.includes(channel.data)) return err({ code: "NOT_FOUND" });
    return await withTx(db, async (tx, txNow) => {
        const account = await lockActiveAccount(tx, params.accountId, txNow);
        if (!account.ok) return account;
        const held = await heldChannels(tx, { ...params, txNow });
        if (!held.ok) return held;
        if (!held.value.has(channel.data)) return err({ code: "CHANNEL_NOT_ALLOWED" });
        const current = await findCurrentRelease(tx, {
            productId: LOADER_PRODUCT,
            channel: channel.data,
        });
        if (!current.ok) return current;
        if (current.value === null) return err({ code: "RELEASE_UNAVAILABLE" });
        return ok(current.value.seal);
    });
}

// Whether the digest is the loader's or host's in the current loader seal of a channel the
// account holds. A replaced seal's artifacts are no longer offered, and nothing says whether a
// refused digest names a file.
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
        const held = await heldChannels(tx, { ...params, txNow });
        if (!held.ok) return held;
        for (const channel of held.value) {
            const current = await findCurrentRelease(tx, { productId: LOADER_PRODUCT, channel });
            if (!current.ok) return current;
            if (current.value === null) continue;
            const seal = parseReleaseSeal(current.value.seal);
            if (!seal.ok) continue;
            for (const kind of ["loader", "host"] as const) {
                const digest = digestOf(seal.value, kind);
                if (digest !== null && toHex(digest) === params.digest) return ok(null);
            }
        }
        return err({ code: "NOT_FOUND" });
    });
}
