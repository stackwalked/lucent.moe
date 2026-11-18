import { expect, test } from "bun:test";
import { type Environment, readServerConfig } from "../src/config.ts";

const KEY = "k".repeat(43);

function env(overrides: Partial<Environment>): Environment {
    return {
        LUCENT_DATABASE_URL: "postgres://server@127.0.0.1:5432/lucent",
        LUCENT_INTERNAL_LISTEN: "127.0.0.1:4712",
        LUCENT_WEB_INTERNAL_KEY: KEY,
        LUCENT_PRODUCTS_DIR: "/srv/lucent/products",
        ...overrides,
    };
}

test("the internal listener accepts loopback and unix sockets", () => {
    for (const [raw, expected] of [
        ["127.0.0.1:4712", { kind: "loopback", hostname: "127.0.0.1", port: 4712 }],
        ["[::1]:9", { kind: "loopback", hostname: "::1", port: 9 }],
        ["unix:/run/lucent/internal.sock", { kind: "unix", path: "/run/lucent/internal.sock" }],
    ] as const) {
        const config = readServerConfig(env({ LUCENT_INTERNAL_LISTEN: raw }));
        expect(config.ok && config.value.internalListen).toEqual(expected);
    }
});

test("the internal listener refuses any address beyond loopback", () => {
    for (const raw of [
        "0.0.0.0:4712",
        "[::]:4712",
        "localhost:4712",
        "10.0.0.5:4712",
        "127.0.0.1:0",
    ]) {
        const config = readServerConfig(env({ LUCENT_INTERNAL_LISTEN: raw }));
        expect(config.ok).toBe(false);
    }
});

test("a weak peer key is refused without echoing it", () => {
    const weak = "short-but-secret";
    const config = readServerConfig(env({ LUCENT_WEB_INTERNAL_KEY: weak }));
    expect(config.ok).toBe(false);
    expect(JSON.stringify(config)).not.toContain(weak);
});

test("every missing variable is named at once", () => {
    const config = readServerConfig({
        LUCENT_DATABASE_URL: undefined,
        LUCENT_INTERNAL_LISTEN: undefined,
        LUCENT_WEB_INTERNAL_KEY: undefined,
        LUCENT_PRODUCTS_DIR: undefined,
    });
    expect(config.ok).toBe(false);
    const problems = config.ok ? [] : config.error.problems;
    for (const name of [
        "LUCENT_DATABASE_URL",
        "LUCENT_INTERNAL_LISTEN",
        "LUCENT_WEB_INTERNAL_KEY",
        "LUCENT_PRODUCTS_DIR",
    ]) {
        expect(problems.some((problem) => problem.startsWith(name))).toBe(true);
    }
});
