import { expect, test } from "bun:test";
import { readShoutInput } from "../src/features/shouts/command.ts";

test.each([
    [
        "staff: a username",
        "/purge Alice",
        "staff",
        { kind: "purge", target: { username: "alice" } },
    ],
    ["staff: a count", "/purge 2", "staff", { kind: "purge", target: { last: 2 } }],
    ["staff: the least", "/purge 1", "staff", { kind: "purge", target: { last: 1 } }],
    ["staff: the most", "/purge 100", "staff", { kind: "purge", target: { last: 100 } }],
    ["staff: over the most", "/purge 101", "staff", { kind: "usage" }],
    ["staff: zero", "/purge 0", "staff", { kind: "usage" }],
    ["staff: no argument", "/purge", "staff", { kind: "usage" }],
    ["staff: two arguments", "/purge a b", "staff", { kind: "usage" }],
    ["staff: not a username", "/purge a-b", "staff", { kind: "usage" }],
    [
        "staff: spaces around",
        "  /purge   bob  ",
        "staff",
        { kind: "purge", target: { username: "bob" } },
    ],
    [
        "staff: a shout that only mentions it",
        "do not /purge 2",
        "staff",
        { kind: "post", body: "do not /purge 2" },
    ],
    ["staff: a longer word", "/purged 2", "staff", { kind: "post", body: "/purged 2" }],
    ["others: the same text is a shout", "/purge 2", "member", { kind: "post", body: "/purge 2" }],
    ["others: a shout", "hello", "member", { kind: "post", body: "hello" }],
] as const)("a shout input: %s", (_name, text, who, expected) => {
    expect(readShoutInput(text, who)).toEqual(expected);
});
