import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { blake2b256 } from "@lucent/bundle/crypto";
import { trySync } from "@lucent/core/contain";
import { systemCryptoRng } from "@lucent/core/rng";
import { setupPath } from "./auth/setup.ts";
import { bootstrapRootAccount, recoverRootAccount } from "./authority/writers.ts";
import { processEnvironment, readOpsConfig } from "./config.ts";
import { migrateDatabase, verifySchemaCurrent } from "./db/migrate.ts";
import { openPool } from "./db/pool.ts";
import { describePublishedFactSet, publishFactSet } from "./facts/publishing.ts";
import {
    describePublished,
    publishLoaderRelease,
    publishModuleRelease,
} from "./releases/publish.ts";

// Operator verbs, run against the database the server uses. Exit 1 on any refusal; the reason
// goes to stderr as one JSON object.
const USAGE = `usage:
  ops migrate
  ops bootstrap-superadmin --email <email> --username <username>
  ops recover-root
  ops publish-release --seal <file> --container <file> --manifest <file>
  ops publish-loader --seal <file> --loader <file> --host <file> --artifact-dir <dir>
  ops publish-fact-set --release <hex id> --set <file>
`;

// Publishing reads its artifacts whole: a container is a few MiB, the seal bounds the rest.
async function readArtifact(path: string): Promise<Uint8Array> {
    return await Bun.file(path).bytes();
}

function report(stream: "stdout" | "stderr", value: unknown): void {
    // Release numbers are u64s: bigints, written as decimal strings.
    const text = JSON.stringify(value, (_, field: unknown) =>
        typeof field === "bigint" ? field.toString() : field,
    );
    process[stream].write(`${text}\n`);
}

function usage(): never {
    process.stderr.write(USAGE);
    process.exit(64);
}

const config = readOpsConfig(processEnvironment());
if (!config.ok) {
    report("stderr", config.error);
    process.exit(1);
}

const args = trySync(
    () =>
        parseArgs({
            args: process.argv.slice(2),
            allowPositionals: true,
            options: {
                email: { type: "string" },
                username: { type: "string" },
                seal: { type: "string" },
                container: { type: "string" },
                manifest: { type: "string" },
                loader: { type: "string" },
                host: { type: "string" },
                "artifact-dir": { type: "string" },
                release: { type: "string" },
                set: { type: "string" },
            },
        }),
    () => null,
);
if (!args.ok) usage();
const { positionals, values } = args.value;
const [verb, ...extra] = positionals;
if (extra.length > 0) usage();

const { codePublicKey, factsPublicKeys } = config.value;

const db = openPool({
    databaseUrl: config.value.databaseUrl,
    maxConnections: 2,
    applicationName: "platform-ops",
});

async function run(): Promise<number> {
    switch (verb) {
        case "migrate": {
            const applied = await migrateDatabase(db);
            if (!applied.ok) {
                report("stderr", applied.error);
                return 1;
            }
            report("stdout", { applied: applied.value });
            return 0;
        }
        case "bootstrap-superadmin": {
            const { email, username } = values;
            if (email === undefined || username === undefined) usage();
            // The root is written once, against the schema it was written for.
            const schema = await verifySchemaCurrent(db);
            if (!schema.ok) {
                report("stderr", schema.error);
                return 1;
            }
            const root = await bootstrapRootAccount({ db, rng: systemCryptoRng, email, username });
            if (!root.ok) {
                report("stderr", root.error);
                return 1;
            }
            report("stdout", {
                accountId: root.value.accountId,
                setupPath: setupPath(root.value.setupToken),
            });
            return 0;
        }
        case "recover-root": {
            // Signs everyone out of the root account and removes its credentials.
            const root = await recoverRootAccount({ db, rng: systemCryptoRng });
            if (!root.ok) {
                report("stderr", root.error);
                return 1;
            }
            report("stdout", {
                accountId: root.value.accountId,
                setupPath: setupPath(root.value.setupToken),
            });
            return 0;
        }
        case "publish-release": {
            const { seal, container, manifest } = values;
            if (seal === undefined || container === undefined || manifest === undefined) usage();
            if (codePublicKey === null) {
                report("stderr", { code: "NO_CODE_KEY" });
                return 1;
            }
            const published = await publishModuleRelease(db, {
                codeKey: codePublicKey,
                artifacts: {
                    seal: await readArtifact(seal),
                    container: await readArtifact(container),
                    manifest: await readArtifact(manifest),
                },
            });
            if (!published.ok) {
                report("stderr", published.error);
                return 1;
            }
            report("stdout", { staged: describePublished(published.value) });
            return 0;
        }
        case "publish-loader": {
            const { seal, loader, host } = values;
            const artifactDir = values["artifact-dir"];
            if (
                seal === undefined ||
                loader === undefined ||
                host === undefined ||
                artifactDir === undefined
            ) {
                usage();
            }
            if (codePublicKey === null) {
                report("stderr", { code: "NO_CODE_KEY" });
                return 1;
            }
            const artifacts = {
                seal: await readArtifact(seal),
                loader: await readArtifact(loader),
                host: await readArtifact(host),
            };
            // Kept by digest before the release is recorded: a recorded release always has its
            // bytes, and a refused one leaves only content-addressed files a later publish reuses.
            await mkdir(artifactDir, { recursive: true });
            for (const bytes of [artifacts.loader, artifacts.host]) {
                await Bun.write(join(artifactDir, blake2b256(bytes).toHex()), bytes);
            }
            const published = await publishLoaderRelease(db, {
                codeKey: codePublicKey,
                artifacts,
            });
            if (!published.ok) {
                report("stderr", published.error);
                return 1;
            }
            report("stdout", { staged: describePublished(published.value) });
            return 0;
        }
        case "publish-fact-set": {
            const { release, set } = values;
            if (release === undefined || set === undefined) usage();
            if (!/^[0-9a-f]{32}$/.test(release)) usage();
            if (factsPublicKeys.length === 0) {
                report("stderr", { code: "NO_FACTS_KEY" });
                return 1;
            }
            const published = await publishFactSet(db, {
                factsKeys: factsPublicKeys,
                releaseId: Uint8Array.fromHex(release),
                bundle: await readArtifact(set),
            });
            if (!published.ok) {
                report("stderr", published.error);
                return 1;
            }
            report("stdout", { staged: describePublishedFactSet(published.value) });
            return 0;
        }
        default:
            return usage();
    }
}

const code = await run();
await db.close();
process.exit(code);
