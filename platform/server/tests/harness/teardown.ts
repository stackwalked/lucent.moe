import { afterAll } from "bun:test";
import { shutdownSharedTestCluster } from "./pg-test.ts";

// Preloaded by bunfig.toml, so this afterAll is global: it runs once, after every test file.
afterAll(async () => {
    await shutdownSharedTestCluster();
});
