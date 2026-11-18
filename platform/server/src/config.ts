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
};

const POSTGRES_URL = /^postgres(?:ql)?:\/\/./;

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
    if (problems.length > 0 || internalListen === null) {
        return err({ code: "CONFIG_INVALID", problems });
    }
    return ok({ databaseUrl, internalListen, webInternalKey, productsDir });
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
    } = process.env;
    return {
        LUCENT_DATABASE_URL,
        LUCENT_INTERNAL_LISTEN,
        LUCENT_WEB_INTERNAL_KEY,
        LUCENT_PRODUCTS_DIR,
    };
}
