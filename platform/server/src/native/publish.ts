import { blake2b256 } from "@lucent/bundle/crypto";
import { parseReleaseManifestV2 } from "@lucent/bundle/release-manifest";
import { equalBytes } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { toHex } from "@lucent/core/scalars";
import { unpackContainer } from "@lucent/wire/container";
import {
    type ArtifactKind,
    digestOf,
    isModuleSeal,
    type ReleaseSeal,
    verifyReleaseSeal,
} from "@lucent/wire/release-seal";
import { z } from "zod";
import { type Db, type DbFailure, execute, queryOne, sql, type Tx } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { LOADER_CHANNEL, LOADER_PRODUCT } from "./releases.ts";

// `ops publish-release` and `ops publish-loader`: a seal enters staged, verified against the
// offline code key, its number above every number signed for its product and channel before it,
// and every artifact it names matching its digest. The release it names is stored once; going
// back to it is the same release under a new seal. Promotion (current_release) stays web's.
// Nothing here signs: a taken-over server can withhold a release, never make one.

export type PublishRefusal =
    | { readonly code: "SEAL_INVALID" }
    | { readonly code: "SEAL_UNSIGNED" }
    | { readonly code: "WRONG_KIND"; readonly expected: "module" | "loader" }
    | { readonly code: "NUMBER_NOT_ABOVE"; readonly highest: bigint }
    | { readonly code: "DIGEST_MISMATCH"; readonly artifact: ArtifactKind }
    | { readonly code: "CONTAINER_INVALID" }
    | { readonly code: "CONTAINER_DISAGREES"; readonly field: "release" | "boot_info_version" }
    | { readonly code: "MANIFEST_INVALID" }
    | { readonly code: "MANIFEST_DISAGREES" }
    | { readonly code: "LOADER_CHANNEL_INVALID" }
    | { readonly code: "NUMBER_TOO_LARGE" }
    | { readonly code: "RELEASE_DIFFERS" };

export type Published = {
    readonly release: Uint8Array;
    readonly product: string;
    readonly channel: string;
    readonly number: bigint;
};

export type ModuleArtifacts = {
    readonly seal: Uint8Array;
    readonly container: Uint8Array;
    readonly manifest: Uint8Array;
};

export type LoaderArtifacts = {
    readonly seal: Uint8Array;
    readonly loader: Uint8Array;
    readonly host: Uint8Array;
};

function matches(seal: ReleaseSeal, kind: ArtifactKind, bytes: Uint8Array): boolean {
    const digest = digestOf(seal, kind);
    return digest !== null && equalBytes(digest, blake2b256(bytes));
}

async function verifiedSeal(
    bytes: Uint8Array,
    codeKey: Uint8Array,
): Promise<Result<ReleaseSeal, PublishRefusal>> {
    const seal = await verifyReleaseSeal(bytes, codeKey);
    if (seal.ok) return seal;
    return err(
        seal.error.code === "BAD_SIGNATURE" ? { code: "SEAL_UNSIGNED" } : { code: "SEAL_INVALID" },
    );
}

// Everything the module's artifacts can be checked for without the database: the seal's digests,
// and that the container and manifest say what the seal says.
function checkModule(seal: ReleaseSeal, artifacts: ModuleArtifacts): Result<null, PublishRefusal> {
    if (!isModuleSeal(seal)) return err({ code: "WRONG_KIND", expected: "module" });
    if (!matches(seal, "container", artifacts.container)) {
        return err({ code: "DIGEST_MISMATCH", artifact: "container" });
    }
    if (!matches(seal, "release_manifest", artifacts.manifest)) {
        return err({ code: "DIGEST_MISMATCH", artifact: "release_manifest" });
    }
    const container = unpackContainer(artifacts.container);
    if (!container.ok) return err({ code: "CONTAINER_INVALID" });
    if (!equalBytes(container.value.release, seal.release)) {
        return err({ code: "CONTAINER_DISAGREES", field: "release" });
    }
    if (container.value.bootInfoVersion !== seal.bootInfoVersion) {
        return err({ code: "CONTAINER_DISAGREES", field: "boot_info_version" });
    }
    const manifest = parseReleaseManifestV2(artifacts.manifest);
    if (!manifest.ok) return err({ code: "MANIFEST_INVALID" });
    if (manifest.value.product !== seal.product) return err({ code: "MANIFEST_DISAGREES" });
    return ok(null);
}

function checkLoader(seal: ReleaseSeal, artifacts: LoaderArtifacts): Result<null, PublishRefusal> {
    if (isModuleSeal(seal) || seal.product !== LOADER_PRODUCT) {
        return err({ code: "WRONG_KIND", expected: "loader" });
    }
    if (seal.channel !== LOADER_CHANNEL) return err({ code: "LOADER_CHANNEL_INVALID" });
    if (!matches(seal, "loader", artifacts.loader)) {
        return err({ code: "DIGEST_MISMATCH", artifact: "loader" });
    }
    if (!matches(seal, "host", artifacts.host)) {
        return err({ code: "DIGEST_MISMATCH", artifact: "host" });
    }
    return ok(null);
}

// Seal numbers are stored as bigint.
const MAX_STORED_NUMBER = (1n << 63n) - 1n;

// The highest number signed for the product and channel, staged or promoted. Read under a
// transaction lock on the product and channel, so two publishes can't both take the next number.
async function highestNumber(tx: Tx, seal: ReleaseSeal): Promise<Result<bigint, DbFailure>> {
    const locked = await execute(
        tx,
        sql`select pg_advisory_xact_lock(hashtextextended(
                ${`lucent.release:${seal.product}:${seal.channel}`}, 0))`,
    );
    if (!locked.ok) return locked;
    const row = await queryOne(
        tx,
        z.object({ highest: z.coerce.bigint().nullable() }),
        sql`select max(number) as highest from release_seal
            where product_id = ${seal.product} and channel = ${seal.channel}`,
    );
    if (!row.ok) return row;
    return ok(row.value?.highest ?? 0n);
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
    if (left === null || right === null) return left === right;
    return equalBytes(left, right);
}

// The release the seal names, written once. A release signed again (going back to it) must be
// the same release: same product, channel, container and manifest.
async function storeRelease(
    tx: Tx,
    params: StoreParams,
): Promise<Result<null, PublishRefusal | DbFailure>> {
    const { seal } = params;
    const inserted = await execute(
        tx,
        sql`insert into release (id, product_id, channel, container, manifest)
            values (${seal.release}, ${seal.product}, ${seal.channel}, ${params.container},
                    ${params.manifest})
            on conflict (id) do nothing`,
    );
    if (!inserted.ok) return inserted;
    if (inserted.value === 1) return ok(null);
    const stored = await queryOne(
        tx,
        z.object({
            product_id: z.string(),
            channel: z.string(),
            container: z.instanceof(Uint8Array).nullable(),
            manifest: z.instanceof(Uint8Array).nullable(),
        }),
        sql`select product_id, channel, container, manifest from release where id = ${seal.release}`,
    );
    if (!stored.ok) return stored;
    invariant(stored.value !== null, "a release that conflicted on its id exists");
    const same =
        stored.value.product_id === seal.product &&
        stored.value.channel === seal.channel &&
        sameBytes(stored.value.container, params.container) &&
        sameBytes(stored.value.manifest, params.manifest);
    return same ? ok(null) : err({ code: "RELEASE_DIFFERS" });
}

type StoreParams = {
    readonly seal: ReleaseSeal;
    readonly sealBytes: Uint8Array;
    readonly container: Uint8Array | null;
    readonly manifest: Uint8Array | null;
};

async function store(
    db: Db,
    params: StoreParams,
): Promise<Result<Published, PublishRefusal | DbFailure>> {
    const { seal } = params;
    if (seal.number > MAX_STORED_NUMBER) return err({ code: "NUMBER_TOO_LARGE" });
    return await withTx(db, async (tx) => {
        const highest = await highestNumber(tx, seal);
        if (!highest.ok) return highest;
        if (seal.number <= highest.value) {
            return err({ code: "NUMBER_NOT_ABOVE", highest: highest.value });
        }
        const release = await storeRelease(tx, params);
        if (!release.ok) return release;
        const inserted = await execute(
            tx,
            sql`insert into release_seal (product_id, channel, number, release_id, seal)
                values (${seal.product}, ${seal.channel}, ${seal.number}, ${seal.release},
                        ${params.sealBytes})`,
        );
        if (!inserted.ok) return inserted;
        return ok({
            release: seal.release,
            product: seal.product,
            channel: seal.channel,
            number: seal.number,
        });
    });
}

export async function publishModuleRelease(
    db: Db,
    params: { readonly codeKey: Uint8Array; readonly artifacts: ModuleArtifacts },
): Promise<Result<Published, PublishRefusal | DbFailure>> {
    const { artifacts } = params;
    const seal = await verifiedSeal(artifacts.seal, params.codeKey);
    if (!seal.ok) return seal;
    const checked = checkModule(seal.value, artifacts);
    if (!checked.ok) return checked;
    return await store(db, {
        seal: seal.value,
        sealBytes: artifacts.seal,
        container: artifacts.container,
        manifest: artifacts.manifest,
    });
}

// The loader's and host's bytes aren't stored in the database: the caller keeps them (ops writes
// them under the artifact directory, by digest) before this records the release.
export async function publishLoaderRelease(
    db: Db,
    params: { readonly codeKey: Uint8Array; readonly artifacts: LoaderArtifacts },
): Promise<Result<Published, PublishRefusal | DbFailure>> {
    const { artifacts } = params;
    const seal = await verifiedSeal(artifacts.seal, params.codeKey);
    if (!seal.ok) return seal;
    const checked = checkLoader(seal.value, artifacts);
    if (!checked.ok) return checked;
    return await store(db, {
        seal: seal.value,
        sealBytes: artifacts.seal,
        container: null,
        manifest: null,
    });
}

// What ops prints for a published release.
export function describePublished(published: Published): Record<string, string> {
    return {
        release: toHex(published.release),
        product: published.product,
        channel: published.channel,
        number: published.number.toString(),
    };
}
