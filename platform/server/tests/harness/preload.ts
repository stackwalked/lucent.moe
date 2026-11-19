import { afterAll, beforeAll } from "bun:test";
import { shutdownSharedEphemeralCluster } from "@lucent/testing/postgres";
import { sharedTestCluster } from "./pg-test.ts";

// Preloaded by bunfig.toml, so these hooks are global: each runs once, around every test file.

// Started here, not by the first test that asks: inside a test, initdb and migration spend that
// test's 5s budget, which a loaded machine (`moon run :check`) overruns. Bun then kills what the
// timed-out test spawned, initdb or postgres, and every later test fails to connect.
beforeAll(async () => {
    await sharedTestCluster();
}, 60_000);

afterAll(async () => {
    await shutdownSharedEphemeralCluster();
});
