import type { RelyingParty } from "./auth/passkeys.ts";
import { err, ok, type Result } from "./core/result.ts";
import { isStrongPeerKey, MIN_PEER_KEY_LENGTH } from "./core/rpc.ts";

// Only loopback or a Unix socket: the internal listener carries web's and connectors' calls, and
// a peer key is the only thing standing between it and anyone who can reach it.
export type ListenAddress =
    | { readonly kind: "unix"; readonly path: string }
    | { readonly kind: "loopback"; readonly hostname: "127.0.0.1" | "::1"; readonly port: number };

export type ServerConfig = {
    readonly databaseUrl: string;
    readonly internalListen: ListenAddress;
    readonly webInternalKey: string;
    readonly productsDir: string;
    readonly totpKeys: readonly TotpKeyMaterial[];
    readonly relyingParty: RelyingParty;
};

export type OpsConfig = {
    readonly databaseUrl: string;
};

// Names the variables and what's wrong with them, never their values: some of them are secrets.
export type ConfigError = {
    readonly code: "CONFIG_INVALID";
    readonly problems: readonly string[];
};

export type Environment = {
    readonly LUCENT_DATABASE_URL: string | undefined;
    readonly LUCENT_INTERNAL_LISTEN: string | undefined;
    readonly LUCENT_WEB_INTERNAL_KEY: string | undefined;
    readonly LUCENT_PRODUCTS_DIR: string | undefined;
    readonly LUCENT_TOTP_KEYS: string | undefined;
    readonly LUCENT_WEBAUTHN_RP_ID: string | undefined;
    readonly LUCENT_WEBAUTHN_ORIGIN: string | undefined;
};

const POSTGRES_URL = /^postgres(?:ql)?:\/\/./;

export type TotpKeyMaterial = {
    readonly kid: string;
    readonly raw: Uint8Array;
};

// `kid:key,kid:key`, the first sealing new secrets. Order matters, so duplicates are refused
// rather than guessed at.
function parseTotpKeys(raw: string): readonly TotpKeyMaterial[] | null {
    const keys: TotpKeyMaterial[] = [];
    for (const entry of raw.split(",")) {
        const match = /^([a-z0-9-]{1,16}):([A-Za-z0-9_-]{43})$/.exec(entry.trim());
        if (match === null) return null;
        const [, kid = "", encoded = ""] = match;
        if (keys.some((key) => key.kid === kid)) return null;
        keys.push({ kid, raw: Uint8Array.fromBase64(encoded, { alphabet: "base64url" }) });
    }
    return keys.length > 0 ? keys : null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Browsers only allow WebAuthn on https, or http on localhost; the RP ID must be the origin's
// host or a registrable suffix of it.
function parseRelyingParty(rpId: string, origin: string): RelyingParty | null {
    if (!URL.canParse(origin)) return null;
    const url = new URL(origin);
    if (url.origin !== origin) return null;
    const secure =
        url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
    if (!secure || rpId.length === 0) return null;
    if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) return null;
    return { rpId, rpName: "lucent.moe", origin };
}

function parseListen(raw: string): ListenAddress | null {
    if (raw.startsWith("unix:")) {
        const path = raw.slice("unix:".length);
        return path.length > 0 ? { kind: "unix", path } : null;
    }
    const match = /^(127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(raw);
    if (match === null) return null;
    const port = Number(match[2]);
    if (port < 1 || port > 65_535) return null;
    return { kind: "loopback", hostname: match[1] === "[::1]" ? "::1" : "127.0.0.1", port };
}

function readDatabaseUrl(env: Environment, problems: string[]): string {
    const url = env.LUCENT_DATABASE_URL ?? "";
    if (!POSTGRES_URL.test(url)) {
        problems.push("LUCENT_DATABASE_URL must be a postgres:// URL");
    }
    return url;
}

export function readServerConfig(env: Environment): Result<ServerConfig, ConfigError> {
    const problems: string[] = [];
    const databaseUrl = readDatabaseUrl(env, problems);
    const internalListen = parseListen(env.LUCENT_INTERNAL_LISTEN ?? "");
    if (internalListen === null) {
        problems.push(
            "LUCENT_INTERNAL_LISTEN must be unix:<path>, 127.0.0.1:<port> or [::1]:<port>",
        );
    }
    const webInternalKey = env.LUCENT_WEB_INTERNAL_KEY ?? "";
    if (!isStrongPeerKey(webInternalKey)) {
        problems.push(
            `LUCENT_WEB_INTERNAL_KEY must be at least ${MIN_PEER_KEY_LENGTH} visible ASCII characters`,
        );
    }
    const productsDir = env.LUCENT_PRODUCTS_DIR ?? "";
    if (productsDir.length === 0) {
        problems.push("LUCENT_PRODUCTS_DIR must name the products/ directory");
    }
    const totpKeys = parseTotpKeys(env.LUCENT_TOTP_KEYS ?? "");
    if (totpKeys === null) {
        problems.push(
            "LUCENT_TOTP_KEYS must be kid:key pairs, comma-separated, newest first; each key 32 bytes in base64url",
        );
    }
    const relyingParty = parseRelyingParty(
        env.LUCENT_WEBAUTHN_RP_ID ?? "",
        env.LUCENT_WEBAUTHN_ORIGIN ?? "",
    );
    if (relyingParty === null) {
        problems.push(
            "LUCENT_WEBAUTHN_ORIGIN must be an https:// origin (or http://localhost) whose host is LUCENT_WEBAUTHN_RP_ID or under it",
        );
    }
    if (
        problems.length > 0 ||
        internalListen === null ||
        totpKeys === null ||
        relyingParty === null
    ) {
        return err({ code: "CONFIG_INVALID", problems });
    }
    return ok({
        databaseUrl,
        internalListen,
        webInternalKey,
        productsDir,
        totpKeys,
        relyingParty,
    });
}

export function readOpsConfig(env: Environment): Result<OpsConfig, ConfigError> {
    const problems: string[] = [];
    const databaseUrl = readDatabaseUrl(env, problems);
    if (problems.length > 0) {
        return err({ code: "CONFIG_INVALID", problems });
    }
    return ok({ databaseUrl });
}

// The one read of the process environment (ast-grep: ts-no-ambient-env).
export function processEnvironment(): Environment {
    const {
        LUCENT_DATABASE_URL,
        LUCENT_INTERNAL_LISTEN,
        LUCENT_WEB_INTERNAL_KEY,
        LUCENT_PRODUCTS_DIR,
        LUCENT_TOTP_KEYS,
        LUCENT_WEBAUTHN_RP_ID,
        LUCENT_WEBAUTHN_ORIGIN,
    } = process.env;
    return {
        LUCENT_DATABASE_URL,
        LUCENT_INTERNAL_LISTEN,
        LUCENT_WEB_INTERNAL_KEY,
        LUCENT_PRODUCTS_DIR,
        LUCENT_TOTP_KEYS,
        LUCENT_WEBAUTHN_RP_ID,
        LUCENT_WEBAUTHN_ORIGIN,
    };
}
