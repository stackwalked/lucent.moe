import { expect, test } from "bun:test";
import { readWebConfig, type WebEnvironment } from "../src/server/config.ts";
import { clientOf } from "../src/server/gates.ts";

test("the client is the address Caddy appended, not what the client claimed before it", () => {
    const req = new Request("https://lucent.moe/", {
        headers: { "x-forwarded-for": "10.0.0.1, 198.51.100.7", "user-agent": "Firefox/140.0" },
    });
    expect(clientOf(req, "127.0.0.1")).toEqual({ ip: "198.51.100.7", userAgent: "Firefox/140.0" });
});

test("without a usable forwarded address the client is the socket's peer", () => {
    const forged = new Request("https://lucent.moe/", {
        headers: { "x-forwarded-for": "not-an-ip" },
    });
    expect(clientOf(forged, "::1").ip).toBe("::1");
    expect(clientOf(new Request("https://lucent.moe/"), null).ip).toBe("0.0.0.0");
});

function env(overrides: Partial<WebEnvironment>): WebEnvironment {
    return {
        LUCENT_WEB_LISTEN: "unix:/run/lucent/web.sock",
        LUCENT_PLATFORM_INTERNAL_URL: "unix:/run/lucent/internal.sock",
        LUCENT_WEB_INTERNAL_KEY: "k".repeat(43),
        LUCENT_PUBLIC_ORIGIN: "https://lucent.moe",
        ...overrides,
    };
}

test("the peer key only ever goes to platform on this machine", () => {
    for (const url of ["http://10.0.0.5:4712", "https://127.0.0.1:4712", "http://platform:4712"]) {
        expect(readWebConfig(env({ LUCENT_PLATFORM_INTERNAL_URL: url })).ok).toBe(false);
    }
    expect(readWebConfig(env({ LUCENT_PLATFORM_INTERNAL_URL: "http://127.0.0.1:4712" })).ok).toBe(
        true,
    );
});

test("the public origin is https, or http only on localhost", () => {
    for (const origin of ["http://lucent.moe", "https://lucent.moe/", "https://lucent.moe/x"]) {
        expect(readWebConfig(env({ LUCENT_PUBLIC_ORIGIN: origin })).ok).toBe(false);
    }
    expect(readWebConfig(env({ LUCENT_PUBLIC_ORIGIN: "http://localhost:4710" })).ok).toBe(true);
});

test("the discord invite is optional, and when set is an https link on discord's own hosts", () => {
    const invite = (value: string) => readWebConfig(env({ LUCENT_DISCORD_INVITE_URL: value }));
    const unset = readWebConfig(env({}));
    expect(unset.ok && unset.value.discordInvite).toBe(null);
    const blank = invite("");
    expect(blank.ok && blank.value.discordInvite).toBe(null);
    const set = invite("https://discord.gg/lucent");
    expect(set.ok && set.value.discordInvite).toBe("https://discord.gg/lucent");
    expect(invite("https://discord.com/invite/lucent").ok).toBe(true);
    for (const bad of [
        "http://discord.gg/lucent",
        "https://discord.gg.evil.example/x",
        "https://example.com/discord.gg",
        "https://user@discord.gg/x",
        "discord.gg/lucent",
    ]) {
        expect(invite(bad).ok).toBe(false);
    }
});
