import { deliverAll, toBundleBytes } from "@lucent/bundle/bundle";
import {
    type FactSetHeader,
    fromLiteral,
    type ModuleKey,
    toSignedBytes,
} from "@lucent/bundle/fact-set";
import { leafHash, treeRoot } from "@lucent/bundle/merkle";
import {
    type LocatedFact,
    type ManifestCapability,
    manifestDigest,
} from "@lucent/bundle/release-manifest";
import { invariant } from "@lucent/core/contain";
import type { SeededRng } from "@lucent/core/rng";
import { signWithSeed } from "@lucent/wire/session-crypto";
import { type Db, execute, sql } from "../src/db/pool.ts";
import { publishFactSet } from "../src/facts/publishing.ts";
import { publishRelease } from "./native-fixtures.ts";
// The facts key is a test key (RFC 8032's first); the release links three facts, the first two
// needed by a core capability and the third by an optional one.

export const FACTS_SEED = Uint8Array.fromHex(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
);
export const FACTS_KEY = Uint8Array.fromHex(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
);
export const OTHER_SEED = Uint8Array.fromHex(
    "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
);

// All in GAME's module.
export const FACTS: readonly LocatedFact[] = [
    { key: 0x10n, kind: 1, module: 0x1234n },
    { key: 0x20n, kind: 1, module: 0x1234n },
    { key: 0x30n, kind: 1, module: 0x1234n },
];
export const CAPABILITIES: readonly ManifestCapability[] = [
    { key: 0xa0n, level: "core", members: [0x10n, 0x20n] },
    { key: 0xb0n, level: "optional", members: [0x30n] },
];

// The module build startBody reports.
export const GAME: ModuleKey = {
    nameHash: 0x1234n,
    timeDateStamp: 0x5566_7788,
    sizeOfImage: 0x0040_0000,
};
export const OTHER_GAME: ModuleKey = { nameHash: 0x9999n, timeDateStamp: 1, sizeOfImage: 2 };

export async function factSetBytes(params: {
    readonly keys: readonly bigint[];
    readonly revision?: number;
    readonly modules?: readonly ModuleKey[];
    readonly digest?: Uint8Array;
    readonly seed?: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
    const entries = params.keys.map((key) => fromLiteral(key, key + 1n));
    const unsigned: FactSetHeader = {
        game: 1,
        revision: params.revision ?? 1,
        modules: params.modules ?? [GAME],
        findersCommit: new Uint8Array(20).fill(0xc0),
        manifestDigest: params.digest ?? manifestDigest(FACTS),
        entryCount: entries.length,
        merkleRoot: treeRoot(entries.map(leafHash)),
        signature: new Uint8Array(64),
    };
    const signature = await signWithSeed(params.seed ?? FACTS_SEED, toSignedBytes(unsigned));
    return toBundleBytes([deliverAll({ header: { ...unsigned, signature }, entries })]);
}

export async function publishWith(
    db: Db,
    release: Uint8Array,
    params: Parameters<typeof factSetBytes>[0],
) {
    return await publishFactSet(db, {
        factsKeys: [FACTS_KEY],
        releaseId: release,
        bundle: await factSetBytes(params),
    });
}

export async function coreRelease(db: Db, rng: SeededRng) {
    return await publishRelease(db, rng, {
        product: "cs2",
        channel: "alpha",
        facts: FACTS,
        capabilities: CAPABILITIES,
    });
}

export async function promote(db: Db, release: Uint8Array, build: ModuleKey, revision: number) {
    const promoted = await execute(
        db,
        sql`insert into current_fact_set
                (release_id, name_hash, time_date_stamp, size_of_image, revision)
            values (${release}, ${build.nameHash.toString()}::numeric, ${build.timeDateStamp},
                    ${build.sizeOfImage}, ${revision})
            on conflict (release_id, name_hash, time_date_stamp, size_of_image)
            do update set revision = excluded.revision`,
    );
    invariant(promoted.ok, `promoting the fact set failed: ${JSON.stringify(promoted)}`);
}
