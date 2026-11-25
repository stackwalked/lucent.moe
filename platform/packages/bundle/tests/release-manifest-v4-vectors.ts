import { join } from "node:path";
import { z } from "zod";
import { type ReleaseManifestV4, toReleaseManifestV4Bytes } from "../src/release-manifest.ts";
import { hexU64 } from "./fixtures.ts";

// What contracts/release-manifest/v4 holds: made by the TS encoder; native must match.
// `bun tests/release-manifest-v4-vectors.ts` writes it; release-manifest-v4.test.ts checks the
// committed files equal what this makes. Each manifest is a version 3 vector's with the data
// response byte after it, so the two versions share everything else.

export type Vector = { readonly bytes: Uint8Array; readonly json: unknown };

const CONTRACTS = join(import.meta.dir, "..", "..", "..", "..", "contracts", "release-manifest");

const V3Json = z.object({
    product: z.string(),
    facts: z.array(z.strictObject({ key: z.string(), kind: z.number(), module: z.string() })),
    capabilities: z.array(
        z.strictObject({
            key: z.string(),
            level: z.enum(["optional", "core"]),
            members: z.array(z.string()),
        }),
    ),
    features: z.array(z.strictObject({ key: z.string(), tag: z.string() })),
});

const u64 = (text: string) => hexU64.parse(text);

async function fromV3(name: string) {
    const json = V3Json.parse(await Bun.file(join(CONTRACTS, "v3", `${name}.json`)).json());
    const manifest = {
        product: json.product,
        facts: json.facts.map((fact) => ({
            ...fact,
            key: u64(fact.key),
            module: u64(fact.module),
        })),
        capabilities: json.capabilities.map((capability) => ({
            ...capability,
            key: u64(capability.key),
            members: capability.members.map(u64),
        })),
        features: json.features.map((feature) => ({ ...feature, key: u64(feature.key) })),
    };
    return { json, manifest };
}

export async function releaseManifestV4Vectors(): Promise<Readonly<Record<string, Vector>>> {
    const vectors: Record<string, Vector> = {};
    // The module that reads data response v3, and one built before it that stays on v2.
    const made: readonly [string, string, 2 | 3][] = [
        ["modules", "modules", 3],
        ["empty", "empty", 2],
    ];
    for (const [name, source, dataResponse] of made) {
        const { json, manifest } = await fromV3(source);
        const full: ReleaseManifestV4 = { ...manifest, dataResponse };
        vectors[name] = {
            bytes: toReleaseManifestV4Bytes(full),
            json: { format: 4, ...json, data_response: dataResponse },
        };
    }
    // A version the server can't answer in: the encoder refuses to write it.
    const modules = vectors["modules"]?.bytes ?? new Uint8Array();
    const unknown = modules.slice();
    unknown[unknown.byteLength - 1] = 4;
    vectors["reject_data_response"] = {
        bytes: unknown,
        json: { format: 4, error: "MALFORMED", defect: "a data response version of 4" },
    };
    return vectors;
}

export function toVectorJson(json: unknown): string {
    return `${JSON.stringify(json, null, 2)}\n`;
}

export function vectorPath(name: string, extension: "bin" | "json"): string {
    return join(CONTRACTS, "v4", `${name}.${extension}`);
}

if (import.meta.main) {
    for (const [name, vector] of Object.entries(await releaseManifestV4Vectors())) {
        await Bun.write(vectorPath(name, "bin"), vector.bytes);
        await Bun.write(vectorPath(name, "json"), toVectorJson(vector.json));
    }
}
