import { invariant } from "@lucent/core/contain";
import { systemCryptoRng } from "@lucent/core/rng";
import { migrateDatabase } from "../src/base/db/migrate.ts";
import { openPool } from "../src/base/db/pool.ts";
import { setupPath } from "../src/identity/auth/setup.ts";
import { bootstrapRootAccount, recoverRootAccount } from "../src/identity/authority/writers.ts";
import { openDevCluster } from "./postgres.ts";

// Migrates the dev database and writes its root account; running it again changes nothing.
const cluster = await openDevCluster();
const db = openPool({ databaseUrl: cluster.databaseUrl, maxConnections: 2 });

const migrated = await migrateDatabase(db);
invariant(migrated.ok, `migrating the dev database failed: ${JSON.stringify(migrated)}`);

// `moon run server:seed -- recover-root` signs the dev root out and prints a new setup link.
const root = process.argv.includes("recover-root")
    ? await recoverRootAccount({ db, rng: systemCryptoRng })
    : await bootstrapRootAccount({
          db,
          rng: systemCryptoRng,
          email: "root@lucent.localhost",
          username: "root",
      });
invariant(
    root.ok || root.error.code === "ROOT_ALREADY_EXISTS",
    `seeding the dev root failed: ${JSON.stringify(root)}`,
);
process.stdout.write(
    root.ok
        ? `root ${root.value.accountId}: set it up at ${setupPath(root.value.setupToken)}\n`
        : "root already exists; `moon run server:seed -- recover-root` for a new setup link\n",
);

await db.close();
cluster.release();
