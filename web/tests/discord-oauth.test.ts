import { expect, test } from "bun:test";
import { BearerToken } from "@lucent/core/scalars";
import {
    type DiscordCallback,
    decideDiscordCallback,
    discordAuthorizeUrl,
} from "../src/features/discord/oauth.ts";
import type { FlowState } from "../src/server/flow.ts";

const STATE = BearerToken.parse("s".repeat(43));
const KEPT = { discordState: STATE, discordFor: "apply" } as const;

test("the authorize link names the application, both scopes, the state and the callback", () => {
    const url = new URL(
        discordAuthorizeUrl({
            clientId: "900000000000000003",
            publicOrigin: "https://lucent.moe",
            state: STATE,
        }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
        response_type: "code",
        client_id: "900000000000000003",
        scope: "identify guilds.join",
        state: STATE,
        redirect_uri: "https://lucent.moe/discord/callback",
    });
});

type Case = readonly [
    string,
    FlowState,
    { readonly code: string | null; readonly state: string | null },
    DiscordCallback,
];

const CASES: readonly Case[] = [
    ["no flow at all", {}, { code: "c", state: STATE }, { kind: "refuse", to: "/" }],
    [
        "a flow without a purpose",
        { discordState: STATE },
        { code: "c", state: STATE },
        { kind: "refuse", to: "/" },
    ],
    [
        "a state that differs",
        KEPT,
        { code: "c", state: "x".repeat(43) },
        { kind: "refuse", to: "/apply" },
    ],
    ["no state", KEPT, { code: "c", state: null }, { kind: "refuse", to: "/apply" }],
    [
        "the user declining on discord",
        { ...KEPT, discordFor: "account" },
        { code: null, state: STATE },
        { kind: "refuse", to: "/account" },
    ],
    [
        "an application's code",
        KEPT,
        { code: "c", state: STATE },
        { kind: "finish", for: "apply", code: "c" },
    ],
    [
        "an account's code",
        { ...KEPT, discordFor: "account" },
        { code: "c", state: STATE },
        { kind: "finish", for: "account", code: "c" },
    ],
];

test.each(CASES)("the callback with %s", (_, flow, query, expected) => {
    expect(decideDiscordCallback(flow, query)).toEqual(expected);
});
