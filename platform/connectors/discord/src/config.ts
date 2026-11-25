import { err, ok, type Result } from "@lucent/core/result";
import { isStrongPeerKey, MIN_PEER_KEY_LENGTH } from "@lucent/rpc/contract";
import { Snowflake } from "@lucent/rpc/discord/rules";

// Where platform's internal listener is: its Unix socket in production, loopback in dev.
export type PlatformAddress =
    | { readonly kind: "unix"; readonly path: string }
    | { readonly kind: "http"; readonly origin: string };

export type ConnectorConfig = {
    readonly botToken: string;
    readonly guildId: string;
    readonly peerKey: string;
    readonly platform: PlatformAddress;
};

export type Environment = {
    readonly LUCENT_DISCORD_BOT_TOKEN: string | undefined;
    readonly LUCENT_DISCORD_GUILD_ID: string | undefined;
    readonly LUCENT_DISCORD_INTERNAL_KEY: string | undefined;
    readonly LUCENT_PLATFORM_INTERNAL_URL: string | undefined;
};

// Names the variables and what's wrong with them, never their values.
export type ConfigError = { readonly code: "CONFIG_INVALID"; readonly problems: readonly string[] };

function parsePlatform(raw: string): PlatformAddress | null {
    if (raw.startsWith("unix:")) {
        const path = raw.slice("unix:".length);
        return path.length > 0 ? { kind: "unix", path } : null;
    }
    if (!URL.canParse(raw)) return null;
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return url.protocol === "http:" && loopback && url.origin === raw
        ? { kind: "http", origin: raw }
        : null;
}

export function readConnectorConfig(env: Environment): Result<ConnectorConfig, ConfigError> {
    const problems: string[] = [];
    const botToken = env.LUCENT_DISCORD_BOT_TOKEN ?? "";
    // Discord's tokens are three base64url parts joined by dots, about seventy characters.
    if (!/^[A-Za-z0-9_.-]{50,200}$/.test(botToken)) {
        problems.push("LUCENT_DISCORD_BOT_TOKEN must be the bot's token from the developer portal");
    }
    const guildId = Snowflake.safeParse(env.LUCENT_DISCORD_GUILD_ID ?? "");
    if (!guildId.success) problems.push("LUCENT_DISCORD_GUILD_ID must be the guild's id");
    const peerKey = env.LUCENT_DISCORD_INTERNAL_KEY ?? "";
    if (!isStrongPeerKey(peerKey)) {
        problems.push(
            `LUCENT_DISCORD_INTERNAL_KEY must be at least ${MIN_PEER_KEY_LENGTH} visible ASCII characters`,
        );
    }
    const platform = parsePlatform(env.LUCENT_PLATFORM_INTERNAL_URL ?? "");
    if (platform === null) {
        problems.push(
            "LUCENT_PLATFORM_INTERNAL_URL must be unix:<path> or a loopback http:// origin",
        );
    }
    if (problems.length > 0 || !guildId.success || platform === null) {
        return err({ code: "CONFIG_INVALID", problems });
    }
    return ok({ botToken, guildId: guildId.data, peerKey, platform });
}

// The one read of the process environment (ast-grep: ts-no-ambient-env).
export function processEnvironment(): Environment {
    const {
        LUCENT_DISCORD_BOT_TOKEN,
        LUCENT_DISCORD_GUILD_ID,
        LUCENT_DISCORD_INTERNAL_KEY,
        LUCENT_PLATFORM_INTERNAL_URL,
    } = process.env;
    return {
        LUCENT_DISCORD_BOT_TOKEN,
        LUCENT_DISCORD_GUILD_ID,
        LUCENT_DISCORD_INTERNAL_KEY,
        LUCENT_PLATFORM_INTERNAL_URL,
    };
}
