import { parseArgs } from "node:util";
import { bootstrapRootAccount } from "./authority/writers.ts";
import { processEnvironment, readOpsConfig } from "./config.ts";
import { trySync } from "./core/contain.ts";
import { systemCryptoRng } from "./core/rng.ts";
import { migrateDatabase, verifySchemaCurrent } from "./db/migrate.ts";
import { openPool } from "./db/pool.ts";

// Operator verbs, run against the database the server uses. Exit 1 on any refusal; the reason
// goes to stderr as one JSON object.
const USAGE = `usage:
  ops migrate
  ops bootstrap-superadmin --email <email> --username <username>
`;

function report(stream: "stdout" | "stderr", value: unknown): void {
    process[stream].write(`${JSON.stringify(value)}\n`);
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
            options: { email: { type: "string" }, username: { type: "string" } },
        }),
    () => null,
);
if (!args.ok) usage();
const { positionals, values } = args.value;
const [verb, ...extra] = positionals;
if (extra.length > 0) usage();

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
            report("stdout", root.value);
            return 0;
        }
        default:
            return usage();
    }
}

const code = await run();
await db.close();
process.exit(code);
