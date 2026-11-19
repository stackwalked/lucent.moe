import { expect, test } from "bun:test";
import { parseQuery } from "../src/features/admin/query.ts";

const KEYS = ["status", "role"] as const;

test("known key:value tokens are filters and everything else is search text", () => {
    expect(parseQuery("status:suspended  ali role:role_mod", KEYS)).toEqual({
        tokens: { status: "suspended", role: "role_mod" },
        text: "ali",
        ignored: [],
    });
    expect(parseQuery("op:account.suspend http://x", KEYS)).toEqual({
        tokens: {},
        text: "op:account.suspend http://x",
        ignored: [],
    });
});

test("a repeated or valueless known token filters nothing and is said back as ignored", () => {
    expect(parseQuery(undefined, KEYS)).toEqual({ tokens: {}, text: null, ignored: [] });
    expect(parseQuery("   ", KEYS)).toEqual({ tokens: {}, text: null, ignored: [] });
    expect(parseQuery("status: status:active status:suspended ali", KEYS)).toEqual({
        tokens: { status: "active" },
        text: "ali",
        ignored: ["status:", "status:suspended"],
    });
});
