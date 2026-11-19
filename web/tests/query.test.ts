import { expect, test } from "bun:test";
import { formatQuery, parseQuery } from "../src/features/admin/query.ts";

const KEYS = ["status", "role"] as const;

test("known key:value tokens are filters and everything else is search text", () => {
    expect(parseQuery("status:suspended  ali role:role_mod", KEYS)).toEqual({
        tokens: { status: "suspended", role: "role_mod" },
        text: "ali",
    });
    expect(parseQuery("op:account.suspend http://x", KEYS)).toEqual({
        tokens: {},
        text: "op:account.suspend http://x",
    });
});

test("an empty, repeated or valueless token doesn't become a filter", () => {
    expect(parseQuery(undefined, KEYS)).toEqual({ tokens: {}, text: null });
    expect(parseQuery("   ", KEYS)).toEqual({ tokens: {}, text: null });
    expect(parseQuery("status: status:active status:suspended", KEYS)).toEqual({
        tokens: { status: "active" },
        text: "status: status:suspended",
    });
});

test("a parsed query writes back the same filters", () => {
    const parsed = parseQuery("ali status:active", KEYS);
    expect(parseQuery(formatQuery(parsed, KEYS), KEYS)).toEqual(parsed);
});
