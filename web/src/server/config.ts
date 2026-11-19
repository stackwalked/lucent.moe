import { err, ok, type Result } from "@lucent/core/result";
import { isStrongPeerKey, MIN_PEER_KEY_LENGTH } from "@lucent/rpc/contract";

export type WebListen =
    | { readonly kind: "unix"; readonly path: string }
    | { readonly kind: "loopback"; readonly hostname: "127.0.0.1" | "::1"; readonly port: number };

// Where platform's internal listener is: a Unix socket in production, loopback in dev.
export type PlatformAddress =
    | { readonly kind: "unix"; readonly path: string }
    | { readonly kind: "http"; readonly origin: string };

export type WebConfig = {
    readonly listen: WebListen;
    readonly platform: PlatformAddress;
    readonly peerKey: string;
    // The one origin browsers use (https://lucent.moe); Host, Origin and redirects check against it.
    readonly publicOrigin: string;
};

// Names the variables and what's wrong with them, never their values: the peer key is a secret.
export type ConfigError = { readonly code: "CONFIG_INVALID"; readonly problems: readonly string[] };

export type WebEnvironment = {
    readonly LUCENT_WEB_LISTEN: string | undefined;
    readonly LUCENT_PLATFORM_INTERNAL_URL: string | undefined;
    readonly LUCENT_WEB_INTERNAL_KEY: string | undefined;
    readonly LUCENT_PUBLIC_ORIGIN: string | undefined;
};

function parseListen(raw: string): WebListen | null {
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

function parsePlatform(raw: string): PlatformAddress | null {
    if (raw.startsWith("unix:")) {
        const path = raw.slice("unix:".length);
        return path.length > 0 ? { kind: "unix", path } : null;
    }
    if (!URL.canParse(raw)) return null;
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "http:" || !loopback || url.origin !== raw) return null;
    return { kind: "http", origin: url.origin };
}

function parsePublicOrigin(raw: string): string | null {
    if (!URL.canParse(raw)) return null;
    const url = new URL(raw);
    if (url.origin !== raw) return null;
    const local = url.protocol === "http:" && url.hostname === "localhost";
    return url.protocol === "https:" || local ? url.origin : null;
}

export function readWebConfig(env: WebEnvironment): Result<WebConfig, ConfigError> {
    const problems: string[] = [];
    const listen = parseListen(env.LUCENT_WEB_LISTEN ?? "");
    if (listen === null) {
        problems.push("LUCENT_WEB_LISTEN must be unix:<path>, 127.0.0.1:<port> or [::1]:<port>");
    }
    const platform = parsePlatform(env.LUCENT_PLATFORM_INTERNAL_URL ?? "");
    if (platform === null) {
        problems.push(
            "LUCENT_PLATFORM_INTERNAL_URL must be unix:<path> or a loopback http:// origin",
        );
    }
    const peerKey = env.LUCENT_WEB_INTERNAL_KEY ?? "";
    if (!isStrongPeerKey(peerKey)) {
        problems.push(
            `LUCENT_WEB_INTERNAL_KEY must be at least ${MIN_PEER_KEY_LENGTH} visible ASCII characters`,
        );
    }
    const publicOrigin = parsePublicOrigin(env.LUCENT_PUBLIC_ORIGIN ?? "");
    if (publicOrigin === null) {
        problems.push("LUCENT_PUBLIC_ORIGIN must be an https:// origin (or http://localhost)");
    }
    if (problems.length > 0 || listen === null || platform === null || publicOrigin === null) {
        return err({ code: "CONFIG_INVALID", problems });
    }
    return ok({ listen, platform, peerKey, publicOrigin });
}

// The one read of the process environment (ast-grep: ts-no-ambient-env).
export function processEnvironment(): WebEnvironment {
    const {
        LUCENT_WEB_LISTEN,
        LUCENT_PLATFORM_INTERNAL_URL,
        LUCENT_WEB_INTERNAL_KEY,
        LUCENT_PUBLIC_ORIGIN,
    } = process.env;
    return {
        LUCENT_WEB_LISTEN,
        LUCENT_PLATFORM_INTERNAL_URL,
        LUCENT_WEB_INTERNAL_KEY,
        LUCENT_PUBLIC_ORIGIN,
    };
}
