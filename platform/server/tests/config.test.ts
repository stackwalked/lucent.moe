import { expect, test } from "bun:test";
import { type Environment, readServerConfig } from "../src/config.ts";

const KEY = "k".repeat(43);

function env(overrides: Partial<Environment>): Environment {
    return {
        LUCENT_DATABASE_URL: "postgres://server@127.0.0.1:5432/lucent",
        LUCENT_INTERNAL_LISTEN: "127.0.0.1:4712",
        LUCENT_WEB_INTERNAL_KEY: KEY,
        LUCENT_PRODUCTS_DIR: "/srv/lucent/products",
        LUCENT_TOTP_KEYS: `k1:${"B".repeat(43)}`,
        LUCENT_WEBAUTHN_RP_ID: "lucent.moe",
        LUCENT_WEBAUTHN_ORIGIN: "https://lucent.moe",
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
        LUCENT_TOTP_KEYS: undefined,
        LUCENT_WEBAUTHN_RP_ID: undefined,
        LUCENT_WEBAUTHN_ORIGIN: undefined,
    });
    expect(config.ok).toBe(false);
    const problems = config.ok ? [] : config.error.problems;
    for (const name of [
        "LUCENT_DATABASE_URL",
        "LUCENT_INTERNAL_LISTEN",
        "LUCENT_WEB_INTERNAL_KEY",
        "LUCENT_PRODUCTS_DIR",
        "LUCENT_TOTP_KEYS",
        "LUCENT_WEBAUTHN_ORIGIN",
    ]) {
        expect(problems.some((problem) => problem.startsWith(name))).toBe(true);
    }
});

test("passkeys are refused an origin a browser wouldn't allow them on", () => {
    for (const [rpId, origin] of [
        ["lucent.moe", "http://lucent.moe"],
        ["lucent.moe", "https://evil.example"],
        ["lucent.moe", "https://notlucent.moe"],
        ["lucent.moe", "https://lucent.moe/path"],
        ["auth.lucent.moe", "https://lucent.moe"],
    ] as const) {
        const config = readServerConfig(
            env({ LUCENT_WEBAUTHN_RP_ID: rpId, LUCENT_WEBAUTHN_ORIGIN: origin }),
        );
        expect(config.ok).toBe(false);
    }
    for (const [rpId, origin] of [
        ["lucent.moe", "https://www.lucent.moe"],
        ["localhost", "http://localhost:3000"],
    ] as const) {
        const config = readServerConfig(
            env({ LUCENT_WEBAUTHN_RP_ID: rpId, LUCENT_WEBAUTHN_ORIGIN: origin }),
        );
        expect(config.ok).toBe(true);
    }
});

test("TOTP keys keep their order and refuse a repeated kid", () => {
    const key = (fill: string) => fill.repeat(43);
    const config = readServerConfig(env({ LUCENT_TOTP_KEYS: `b:${key("B")},a:${key("C")}` }));
    expect(config.ok && config.value.totpKeys.map((entry) => entry.kid)).toEqual(["b", "a"]);
    expect(readServerConfig(env({ LUCENT_TOTP_KEYS: `a:${key("C")},a:${key("B")}` })).ok).toBe(
        false,
    );
    expect(readServerConfig(env({ LUCENT_TOTP_KEYS: `a:${key("C").slice(1)}` })).ok).toBe(false);
});

test("the published dev keys are refused unless browsers reach the server from this machine", () => {
    const devKeys = {
        LUCENT_WEB_INTERNAL_KEY: "lucent-dev-internal-key-public-not-a-secret-0000",
        LUCENT_TOTP_KEYS: `k1:${"B".repeat(43)},dev:${"A".repeat(43)}`,
    };
    const released = readServerConfig(env(devKeys));
    expect(!released.ok && released.error.problems).toEqual([
        "LUCENT_WEB_INTERNAL_KEY is the published dev key",
        "LUCENT_TOTP_KEYS holds the published dev key (all zero bytes)",
    ]);
    const local = readServerConfig(
        env({
            ...devKeys,
            LUCENT_WEBAUTHN_RP_ID: "localhost",
            LUCENT_WEBAUTHN_ORIGIN: "http://localhost:4710",
        }),
    );
    expect(local.ok).toBe(true);
});
