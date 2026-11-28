import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createDiscordOauth } from "../src/base/adapters/discord/oauth.ts";

const API = "https://discord.test/api/v10";
const CLIENT_ID = "900000000000000003";
const CLIENT_SECRET = "client-secret-not-a-secret";
const BOT_TOKEN = "bot-token-not-a-secret.0123456789.abcdefghijklmnopqrstuvwxyz";
const GUILD = "500000000000000001";
const USER = "500000000000000010";
const REDIRECT = "https://lucent.test/discord/callback";
const ACCESS = "access-token-for-alice";

type Scripted = { readonly status: number; readonly body?: unknown };
type Call = { readonly req: Request; readonly body: string };

const DEFAULTS = {
    token: { status: 200, body: { access_token: ACCESS, scope: "identify guilds.join" } },
    me: { status: 200, body: { id: USER, username: "alice" } },
    join: { status: 201, body: {} },
};

function discord(script: {
    readonly token?: Scripted;
    readonly me?: Scripted;
    readonly join?: Scripted;
}) {
    const calls: Call[] = [];
    const failures: string[] = [];
    const oauth = createDiscordOauth({
        config: {
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            botToken: BOT_TOKEN,
            guildId: GUILD,
            apiUrl: API,
        },
        redirectUri: REDIRECT,
        onFailure: (detail) => failures.push(detail),
        fetch: async (req) => {
            calls.push({ req, body: await req.clone().text() });
            const { pathname } = new URL(req.url);
            const answer = pathname.endsWith("/oauth2/token")
                ? (script.token ?? DEFAULTS.token)
                : pathname.endsWith("/users/@me")
                  ? (script.me ?? DEFAULTS.me)
                  : (script.join ?? DEFAULTS.join);
            return Response.json(answer.body ?? {}, { status: answer.status });
        },
    });
    return { oauth, calls, failures };
}

test("a code identifies its Discord user and joins them to the guild", async () => {
    const { oauth, calls, failures } = discord({});
    expect(await oauth.identify("the-code")).toEqual(ok({ userId: USER, username: "alice" }));
    expect(failures).toEqual([]);

    const [token, me, join] = calls;
    invariant(token !== undefined && me !== undefined && join !== undefined, "three calls");
    expect([token.req.method, token.req.url]).toEqual(["POST", `${API}/oauth2/token`]);
    expect(token.req.headers.get("authorization")).toBe(
        `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
    );
    expect(token.req.headers.get("content-type")).toStartWith("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({
        grant_type: "authorization_code",
        code: "the-code",
        redirect_uri: REDIRECT,
    });
    expect([me.req.method, me.req.url]).toEqual(["GET", `${API}/users/@me`]);
    expect(me.req.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect([join.req.method, join.req.url]).toEqual([
        "PUT",
        `${API}/guilds/${GUILD}/members/${USER}`,
    ]);
    expect(join.req.headers.get("authorization")).toBe(`Bot ${BOT_TOKEN}`);
    expect(JSON.parse(join.body)).toEqual({ access_token: ACCESS });
});

test("a member already in the guild is identified all the same", async () => {
    const { oauth, failures } = discord({ join: { status: 204 } });
    expect((await oauth.identify("the-code")).ok).toBe(true);
    expect(failures).toEqual([]);
});

test("a refused code fails and nothing further is called", async () => {
    const { oauth, calls, failures } = discord({
        token: { status: 400, body: { error: "invalid_grant" } },
    });
    expect(await oauth.identify("used")).toEqual(err({ code: "DISCORD_LINK_FAILED" }));
    expect(calls).toHaveLength(1);
    expect(failures).toEqual([]);
});

test("a token or identity Discord fails to give is reported by status and error code, never by value", async () => {
    const down = discord({ token: { status: 500, body: { code: 0 } } });
    expect(await down.oauth.identify("the-code")).toEqual(err({ code: "DISCORD_LINK_FAILED" }));
    expect(down.failures).toEqual(["token status 500 code 0"]);

    const unknown = discord({
        me: { status: 401, body: { message: "401: Unauthorized", code: 0 } },
    });
    expect((await unknown.oauth.identify("the-code")).ok).toBe(false);
    expect(unknown.calls).toHaveLength(2);
    expect(unknown.failures).toEqual(["identity status 401 code 0"]);
    expect(JSON.stringify([down.failures, unknown.failures])).not.toContain(ACCESS);
});

test("a refused join still identifies, and is reported", async () => {
    const { oauth, failures } = discord({ join: { status: 403, body: { code: 50013 } } });
    expect(await oauth.identify("the-code")).toEqual(ok({ userId: USER, username: "alice" }));
    expect(failures).toEqual(["join status 403 code 50013"]);
});

test("a token without the guilds.join scope fails", async () => {
    const { oauth, calls, failures } = discord({
        token: { status: 200, body: { access_token: ACCESS, scope: "identify" } },
    });
    expect(await oauth.identify("the-code")).toEqual(err({ code: "DISCORD_LINK_FAILED" }));
    expect(calls).toHaveLength(1);
    expect(failures).toEqual(["token scope missing"]);
});
