import { bootstrapRootAccount } from "../src/authority/writers.ts";
import { invariant } from "../src/core/contain.ts";
import { systemCryptoRng } from "../src/core/rng.ts";
import { migrateDatabase } from "../src/db/migrate.ts";
import { openPool } from "../src/db/pool.ts";
import { openDevCluster } from "./postgres.ts";

// Migrates the dev database and writes its root account; running it again changes nothing.
const cluster = await openDevCluster();
const db = openPool({ databaseUrl: cluster.databaseUrl, maxConnections: 2 });

const migrated = await migrateDatabase(db);
invariant(migrated.ok, `migrating the dev database failed: ${JSON.stringify(migrated)}`);

const root = await bootstrapRootAccount({
    db,
    rng: systemCryptoRng,
    email: "root@lucent.localhost",
    username: "root",
});
invariant(
    root.ok || root.error.code === "ROOT_ALREADY_EXISTS",
    `bootstrapping the dev root failed: ${JSON.stringify(root)}`,
);
process.stdout.write(root.ok ? `root ${root.value.accountId}\n` : "root already exists\n");

await db.close();
cluster.release();
