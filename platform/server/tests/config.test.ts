import { expect, test } from "bun:test";
import { type Environment, readOpsConfig, readServerConfig } from "../src/config.ts";

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
        LUCENT_DEV_PASSWORD_ONLY: undefined,
        LUCENT_PWNED_PASSWORDS_URL: undefined,
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
        LUCENT_DEV_PASSWORD_ONLY: undefined,
        LUCENT_PWNED_PASSWORDS_URL: undefined,
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

test("the published dev keys and password-only sign-in are refused unless browsers reach the server from this machine", () => {
    const devKeys = {
        LUCENT_WEB_INTERNAL_KEY: "lucent-dev-internal-key-public-not-a-secret-0000",
        LUCENT_TOTP_KEYS: `k1:${"B".repeat(43)},dev:${"A".repeat(43)}`,
        LUCENT_DEV_PASSWORD_ONLY: "1",
    };
    const released = readServerConfig(env(devKeys));
    expect(!released.ok && released.error.problems).toEqual([
        "LUCENT_WEB_INTERNAL_KEY is the published dev key",
        "LUCENT_TOTP_KEYS holds the published dev key (all zero bytes)",
        "LUCENT_DEV_PASSWORD_ONLY is for a localhost WebAuthn origin only",
    ]);
    const local = readServerConfig(
        env({
            ...devKeys,
            LUCENT_WEBAUTHN_RP_ID: "localhost",
            LUCENT_WEBAUTHN_ORIGIN: "http://localhost:4710",
        }),
    );
    expect(local.ok && local.value.passwordOnly).toBe(true);
});

test("the loaders' listener is configured by all four of its variables or none", () => {
    const native = {
        LUCENT_NATIVE_LISTEN: "0.0.0.0:4001",
        LUCENT_NATIVE_ORIGIN: "https://api.lucent.moe",
        LUCENT_LEASE_SIGNING_KEY: "C".repeat(43),
        LUCENT_ARTIFACT_DIR: "/srv/lucent/artifacts",
    };
    const without = readServerConfig(env({}));
    expect(without.ok && without.value.native).toBeNull();
    const configured = readServerConfig(env(native));
    expect(configured.ok && configured.value.native?.listen).toEqual({
        kind: "tcp",
        hostname: "0.0.0.0",
        port: 4001,
    });
    const half = readServerConfig(env({ LUCENT_NATIVE_LISTEN: native.LUCENT_NATIVE_LISTEN }));
    expect(!half.ok && half.error.problems).toEqual([
        "LUCENT_NATIVE_ORIGIN must be an https:// origin (or http://localhost)",
        "LUCENT_LEASE_SIGNING_KEY must be a 32-byte Ed25519 seed in base64url",
        "LUCENT_ARTIFACT_DIR must name the directory ops publish-loader writes to",
    ]);
    expect(
        readServerConfig(env({ ...native, LUCENT_NATIVE_ORIGIN: "http://api.lucent.moe" })).ok,
    ).toBe(false);
});

test("the published dev lease key is refused unless browsers reach the server from this machine", () => {
    const devLease = {
        LUCENT_NATIVE_LISTEN: "127.0.0.1:4711",
        LUCENT_NATIVE_ORIGIN: "http://127.0.0.1:4711",
        LUCENT_LEASE_SIGNING_KEY: "A".repeat(43),
        LUCENT_ARTIFACT_DIR: "/srv/lucent/artifacts",
    };
    const released = readServerConfig(env(devLease));
    expect(!released.ok && released.error.problems).toEqual([
        "LUCENT_LEASE_SIGNING_KEY is the published dev key (all zero bytes)",
    ]);
    const local = readServerConfig(
        env({
            ...devLease,
            LUCENT_WEBAUTHN_RP_ID: "localhost",
            LUCENT_WEBAUTHN_ORIGIN: "http://localhost:4710",
        }),
    );
    expect(local.ok).toBe(true);
});

test("ops publishes only under a configured code key, and refuses a malformed one", () => {
    const key = new Uint8Array(32).fill(7);
    const encoded = key.toBase64({ alphabet: "base64url", omitPadding: true });

    const absent = readOpsConfig(env({}));
    const present = readOpsConfig(env({ LUCENT_CODE_PUBLIC_KEY: encoded }));
    const malformed = readOpsConfig(env({ LUCENT_CODE_PUBLIC_KEY: `${encoded}A` }));

    expect(absent.ok && absent.value.codePublicKey).toBeNull();
    expect(present.ok && present.value.codePublicKey).toEqual(key);
    expect(malformed).toEqual({
        ok: false,
        error: {
            code: "CONFIG_INVALID",
            problems: ["LUCENT_CODE_PUBLIC_KEY must be a 32-byte Ed25519 public key in base64url"],
        },
    });
});

test("ops publishes fact sets only under configured facts keys, and refuses a malformed one", () => {
    const first = new Uint8Array(32).fill(7);
    const second = new Uint8Array(32).fill(9);
    const encode = (key: Uint8Array) => key.toBase64({ alphabet: "base64url", omitPadding: true });

    const absent = readOpsConfig(env({}));
    const several = readOpsConfig(
        env({ LUCENT_FACTS_PUBLIC_KEYS: `${encode(first)}, ${encode(second)}` }),
    );
    const malformed = readOpsConfig(env({ LUCENT_FACTS_PUBLIC_KEYS: `${encode(first)},nope` }));

    expect(absent.ok && absent.value.factsPublicKeys).toEqual([]);
    expect(several.ok && several.value.factsPublicKeys).toEqual([first, second]);
    expect(malformed.ok).toBe(false);
});
