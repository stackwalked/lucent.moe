import { expect, test } from "bun:test";
import { BearerToken, toBase64Url } from "@lucent/core/scalars";
import { decodeFlow, encodeFlow } from "../src/server/flow.ts";

test("a flow cookie reads back as written", () => {
    const state = { signIn: BearerToken.parse("s".repeat(43)), returnTo: "/account/security" };
    expect(decodeFlow(encodeFlow(state))).toEqual(state);
});

test("a tampered or garbage flow cookie is no flow at all", () => {
    for (const raw of [
        "",
        "not base64!",
        "e30x",
        encodeFlow({}).slice(1),
        "eyJzaWduSW4iOiJzaG9ydCJ9",
    ]) {
        expect({ raw, state: decodeFlow(raw) }).toEqual({ raw, state: {} });
    }
});

test("the discord round trip's state and purpose read back, and an unknown purpose is no flow", () => {
    const state = { discordState: BearerToken.parse("d".repeat(43)), discordFor: "apply" } as const;
    expect(decodeFlow(encodeFlow(state))).toEqual(state);
    const forged = toBase64Url(
        new TextEncoder().encode(JSON.stringify({ ...state, discordFor: "admin" })),
    );
    expect(decodeFlow(forged)).toEqual({});
});
