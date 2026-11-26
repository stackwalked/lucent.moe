import { expect, test } from "bun:test";
import { parsePresence } from "../src/features/community/presence.ts";

const digest = "ab".repeat(32);

test.each([
    [
        "a frame with a roster",
        JSON.stringify({
            online: 3,
            roster: [
                { username: "soy", avatar: digest, inGame: true },
                { username: "yuki", avatar: null, inGame: false },
            ],
        }),
        {
            online: 3,
            roster: [
                { username: "soy", avatar: digest, inGame: true },
                { username: "yuki", avatar: null, inGame: false },
            ],
        },
    ],
    ["an empty roster", '{"online":0,"roster":[]}', { online: 0, roster: [] }],
    ["not JSON", "{", null],
    ["no roster, as an older platform wrote it", '{"online":1}', null],
    ["an entry without inGame", '{"online":1,"roster":[{"username":"a","avatar":null}]}', null],
    [
        "an avatar that is neither a string nor null",
        '{"online":1,"roster":[{"username":"a","avatar":1,"inGame":false}]}',
        null,
    ],
    ["an array", "[]", null],
] as const)("a presence frame: %s", (_name, raw, expected) => {
    expect(parsePresence(raw)).toEqual(expected);
});
