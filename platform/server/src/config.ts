import { err, ok, type Result } from "@lucent/core/result";
import { isStrongPeerKey, MIN_PEER_KEY_LENGTH } from "@lucent/rpc/contract";
import { z } from "zod";
import type { MailConfig } from "./adapters/mail/mail.ts";
import { PWNED_PASSWORDS_URL } from "./auth/breach.ts";
import type { RelyingParty } from "./auth/passkeys.ts";

// Only loopback or a Unix socket: the internal listener carries web's and connectors' calls, and
// a peer key is the only thing standing between it and anyone who can reach it.
export type ListenAddress =
    | { readonly kind: "unix"; readonly path: string }
    | { readonly kind: "loopback"; readonly hostname: "127.0.0.1" | "::1"; readonly port: number };

export type ServerConfig = {
    readonly mail?: MailConfig;
    readonly databaseUrl: string;
    readonly internalListen: ListenAddress;
    readonly webInternalKey: string;
    readonly productsDir: string;
    readonly totpKeys: readonly TotpKeyMaterial[];
    readonly relyingParty: RelyingParty;
    // Dev only: a password signs in alone, and staff actions need no step-up.
    readonly passwordOnly: boolean;
    // Where new passwords are checked against known breaches: Have I Been Pwned's range API, or a
    // stand-in for it in tests.
    readonly pwnedPasswordsUrl: string;
    // The loaders' listener, or null to run without one (web's integration tests, a dev server
    // with no native config).
    readonly native: NativeConfig | null;
};

// Where loaders reach the server, and the key that signs their leases. The origin is what DPoP
// proofs name (`htu`): the server sits behind Caddy, so the URL it sees isn't the one signed.
export type NativeConfig = {
    readonly listen: NativeListenAddress;
    readonly origin: string;
    // The 32-byte Ed25519 seed. Never generated at startup: its public half ships inside every
    // signed release, so a key the server made up would sign leases no module accepts.
    readonly leaseSigningSeed: Uint8Array;
    // Where `ops publish-loader` wrote the loader's and host's bytes, by digest; served on /v1.
    readonly artifactDir: string;
};

export type NativeListenAddress =
    | { readonly kind: "unix"; readonly path: string }
    | { readonly kind: "tcp"; readonly hostname: string; readonly port: number };

export type OpsConfig = {
    readonly databaseUrl: string;
    // The offline code key's public half (Ed25519, 32 bytes): every seal ops publishes must verify
    // under it. Null when LUCENT_CODE_PUBLIC_KEY is absent; ops then refuses to publish.
    readonly codePublicKey: Uint8Array | null;
    // The offline facts key's public half, or several while one rotates out: a fact set ops
    // publishes must verify under one of them. Empty when LUCENT_FACTS_PUBLIC_KEYS is absent; ops
    // then refuses to publish fact sets.
    readonly factsPublicKeys: readonly Uint8Array[];
};

// Names the variables and what's wrong with them, never their values: some of them are secrets.
export type ConfigError = {
    readonly code: "CONFIG_INVALID";
    readonly problems: readonly string[];
};

export type Environment = {
    readonly LUCENT_MAIL_PROVIDER?: string | undefined;
    readonly LUCENT_MAIL_API_KEY?: string | undefined;
    readonly LUCENT_MAIL_FROM?: string | undefined;
    readonly LUCENT_DATABASE_URL: string | undefined;
    readonly LUCENT_INTERNAL_LISTEN: string | undefined;
    readonly LUCENT_WEB_INTERNAL_KEY: string | undefined;
    readonly LUCENT_PRODUCTS_DIR: string | undefined;
    readonly LUCENT_TOTP_KEYS: string | undefined;
    readonly LUCENT_WEBAUTHN_RP_ID: string | undefined;
    readonly LUCENT_WEBAUTHN_ORIGIN: string | undefined;
    readonly LUCENT_DEV_PASSWORD_ONLY: string | undefined;
    readonly LUCENT_PWNED_PASSWORDS_URL: string | undefined;
    readonly LUCENT_NATIVE_LISTEN?: string | undefined;
    readonly LUCENT_NATIVE_ORIGIN?: string | undefined;
    readonly LUCENT_LEASE_SIGNING_KEY?: string | undefined;
    readonly LUCENT_ARTIFACT_DIR?: string | undefined;
    readonly LUCENT_CODE_PUBLIC_KEY?: string | undefined;
    readonly LUCENT_FACTS_PUBLIC_KEYS?: string | undefined;
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

// The published values in .config/dev.env, and LUCENT_DEV_PASSWORD_ONLY. They're accepted only
// when browsers can reach the server solely from this machine (a localhost WebAuthn origin), so a
// release configured with one by mistake refuses to start instead of running on a key anyone can
// read, or without second factors.
const DEV_PEER_KEY = "lucent-dev-internal-key-public-not-a-secret-0000";

function isDevTotpKey(key: TotpKeyMaterial): boolean {
    return key.raw.every((byte) => byte === 0);
}

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

function parseNativeListen(raw: string): NativeListenAddress | null {
    if (raw.startsWith("unix:")) {
        const path = raw.slice("unix:".length);
        return path.length > 0 ? { kind: "unix", path } : null;
    }
    const match = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(raw);
    if (match === null) return null;
    const port = Number(match[2]);
    if (port < 1 || port > 65_535) return null;
    const host = match[1] ?? "";
    return { kind: "tcp", hostname: host.replace(/^\[|\]$/g, ""), port };
}

// An origin and nothing else, https unless it is this machine.
function parseNativeOrigin(raw: string): string | null {
    if (!URL.canParse(raw)) return null;
    const url = new URL(raw);
    if (url.origin !== raw) return null;
    const secure =
        url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
    return secure ? raw : null;
}

function parseLeaseSigningKey(raw: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    return Uint8Array.fromBase64(raw, { alphabet: "base64url" });
}

// All four variables or none: a server half-configured for loaders refuses to start rather
// than guessing which half was meant.
function readNativeConfig(env: Environment, problems: string[]): NativeConfig | null {
    const raw = {
        listen: env.LUCENT_NATIVE_LISTEN ?? "",
        origin: env.LUCENT_NATIVE_ORIGIN ?? "",
        key: env.LUCENT_LEASE_SIGNING_KEY ?? "",
        artifactDir: env.LUCENT_ARTIFACT_DIR ?? "",
    };
    if (Object.values(raw).every((value) => value === "")) return null;
    const listen = parseNativeListen(raw.listen);
    if (listen === null) {
        problems.push("LUCENT_NATIVE_LISTEN must be unix:<path> or <ip>:<port>");
    }
    const origin = parseNativeOrigin(raw.origin);
    if (origin === null) {
        problems.push("LUCENT_NATIVE_ORIGIN must be an https:// origin (or http://localhost)");
    }
    const leaseSigningSeed = parseLeaseSigningKey(raw.key);
    if (leaseSigningSeed === null) {
        problems.push("LUCENT_LEASE_SIGNING_KEY must be a 32-byte Ed25519 seed in base64url");
    }
    if (raw.artifactDir === "") {
        problems.push("LUCENT_ARTIFACT_DIR must name the directory ops publish-loader writes to");
    }
    if (listen === null || origin === null || leaseSigningSeed === null || raw.artifactDir === "") {
        return null;
    }
    return { listen, origin, leaseSigningSeed, artifactDir: raw.artifactDir };
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
    const mail = readMailConfig(env, problems);
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
    const passwordOnlyRaw = env.LUCENT_DEV_PASSWORD_ONLY ?? "";
    if (passwordOnlyRaw !== "" && passwordOnlyRaw !== "1") {
        problems.push("LUCENT_DEV_PASSWORD_ONLY must be 1 or unset");
    }
    const passwordOnly = passwordOnlyRaw === "1";
    const pwnedPasswordsUrl = env.LUCENT_PWNED_PASSWORDS_URL ?? PWNED_PASSWORDS_URL;
    if (!/^https?:\/\/[^/]+\/.*\/$/.test(pwnedPasswordsUrl) || !URL.canParse(pwnedPasswordsUrl)) {
        problems.push("LUCENT_PWNED_PASSWORDS_URL must be an http(s) URL ending in /");
    }
    const native = readNativeConfig(env, problems);
    const relyingParty = parseRelyingParty(
        env.LUCENT_WEBAUTHN_RP_ID ?? "",
        env.LUCENT_WEBAUTHN_ORIGIN ?? "",
    );
    if (relyingParty === null) {
        problems.push(
            "LUCENT_WEBAUTHN_ORIGIN must be an https:// origin (or http://localhost) whose host is LUCENT_WEBAUTHN_RP_ID or under it",
        );
    }
    if (relyingParty !== null && !LOCAL_HOSTS.has(new URL(relyingParty.origin).hostname)) {
        if (webInternalKey === DEV_PEER_KEY) {
            problems.push("LUCENT_WEB_INTERNAL_KEY is the published dev key");
        }
        if (totpKeys?.some(isDevTotpKey) === true) {
            problems.push("LUCENT_TOTP_KEYS holds the published dev key (all zero bytes)");
        }
        if (passwordOnly) {
            problems.push("LUCENT_DEV_PASSWORD_ONLY is for a localhost WebAuthn origin only");
        }
        if (native?.leaseSigningSeed.every((byte) => byte === 0) === true) {
            problems.push("LUCENT_LEASE_SIGNING_KEY is the published dev key (all zero bytes)");
        }
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
        ...(mail === null ? {} : { mail }),
        databaseUrl,
        internalListen,
        webInternalKey,
        productsDir,
        totpKeys,
        relyingParty,
        passwordOnly,
        pwnedPasswordsUrl,
        native,
    });
}

// 32 bytes in base64url, as `codekey public` prints it.
function parseCodePublicKey(raw: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    return Uint8Array.fromBase64(raw, { alphabet: "base64url" });
}

export function readOpsConfig(env: Environment): Result<OpsConfig, ConfigError> {
    const problems: string[] = [];
    const databaseUrl = readDatabaseUrl(env, problems);
    const rawCodeKey = env.LUCENT_CODE_PUBLIC_KEY;
    const codePublicKey = rawCodeKey === undefined ? null : parseCodePublicKey(rawCodeKey);
    if (rawCodeKey !== undefined && codePublicKey === null) {
        problems.push("LUCENT_CODE_PUBLIC_KEY must be a 32-byte Ed25519 public key in base64url");
    }
    const factsPublicKeys: Uint8Array[] = [];
    const rawFactsKeys = env.LUCENT_FACTS_PUBLIC_KEYS;
    if (rawFactsKeys !== undefined) {
        for (const raw of rawFactsKeys.split(",")) {
            const key = parseCodePublicKey(raw.trim());
            if (key === null) {
                problems.push(
                    "LUCENT_FACTS_PUBLIC_KEYS must be 32-byte Ed25519 public keys in base64url, comma-separated",
                );
                break;
            }
            factsPublicKeys.push(key);
        }
    }
    if (problems.length > 0) {
        return err({ code: "CONFIG_INVALID", problems });
    }
    return ok({ databaseUrl, codePublicKey, factsPublicKeys });
}

// The one read of the process environment (ast-grep: ts-no-ambient-env).
export function processEnvironment(): Environment {
    const {
        LUCENT_MAIL_PROVIDER,
        LUCENT_MAIL_API_KEY,
        LUCENT_MAIL_FROM,
        LUCENT_DATABASE_URL,
        LUCENT_INTERNAL_LISTEN,
        LUCENT_WEB_INTERNAL_KEY,
        LUCENT_PRODUCTS_DIR,
        LUCENT_TOTP_KEYS,
        LUCENT_WEBAUTHN_RP_ID,
        LUCENT_WEBAUTHN_ORIGIN,
        LUCENT_DEV_PASSWORD_ONLY,
        LUCENT_PWNED_PASSWORDS_URL,
        LUCENT_NATIVE_LISTEN,
        LUCENT_NATIVE_ORIGIN,
        LUCENT_LEASE_SIGNING_KEY,
        LUCENT_ARTIFACT_DIR,
        LUCENT_CODE_PUBLIC_KEY,
        LUCENT_FACTS_PUBLIC_KEYS,
    } = process.env;
    return {
        LUCENT_MAIL_PROVIDER,
        LUCENT_MAIL_API_KEY,
        LUCENT_MAIL_FROM,
        LUCENT_DATABASE_URL,
        LUCENT_INTERNAL_LISTEN,
        LUCENT_WEB_INTERNAL_KEY,
        LUCENT_PRODUCTS_DIR,
        LUCENT_TOTP_KEYS,
        LUCENT_WEBAUTHN_RP_ID,
        LUCENT_WEBAUTHN_ORIGIN,
        LUCENT_DEV_PASSWORD_ONLY,
        LUCENT_PWNED_PASSWORDS_URL,
        LUCENT_NATIVE_LISTEN,
        LUCENT_NATIVE_ORIGIN,
        LUCENT_LEASE_SIGNING_KEY,
        LUCENT_ARTIFACT_DIR,
        LUCENT_CODE_PUBLIC_KEY,
        LUCENT_FACTS_PUBLIC_KEYS,
    };
}

function readMailConfig(env: Environment, problems: string[]): MailConfig | null {
    const provider = env.LUCENT_MAIL_PROVIDER ?? "";
    const apiKey = env.LUCENT_MAIL_API_KEY ?? "";
    const sender = env.LUCENT_MAIL_FROM ?? "";
    if (provider === "" && !apiKey && !sender) return null;
    if (provider === "log" && !apiKey && !sender) return { provider };
    if (
        (provider === "resend" || provider === "brevo") &&
        /^[\x21-\x7e]{1,1024}$/.test(apiKey) &&
        z.email().max(254).safeParse(sender).success
    )
        return { provider, apiKey, sender };
    problems.push(
        "mail requires log without credentials, or resend/brevo with LUCENT_MAIL_API_KEY and LUCENT_MAIL_FROM",
    );
    return null;
}
