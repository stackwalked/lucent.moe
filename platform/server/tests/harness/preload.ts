import { afterAll } from "bun:test";
import { shutdownSharedEphemeralCluster } from "@lucent/testing/postgres";

// Preloaded by bunfig.toml, so this afterAll is global: it runs once, after every test file.
afterAll(async () => {
    await shutdownSharedEphemeralCluster();
});
