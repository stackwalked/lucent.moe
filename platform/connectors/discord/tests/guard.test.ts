import { expect, test } from "bun:test";
import { QUEUE_COPY } from "../src/copy.ts";
import { invitesIn } from "../src/guard.ts";

test("an invite is found by Discord's own hosts and the dsc.gg redirect, not inside a longer host", () => {
    const table: readonly [string, readonly { code: string; resolvable: boolean }[]][] = [
        ["join discord.gg/abc-1", [{ code: "abc-1", resolvable: true }]],
        ["https://discord.com/invite/Abc", [{ code: "Abc", resolvable: true }]],
        ["https://canary.discordapp.com/invite/x", [{ code: "x", resolvable: true }]],
        ["`DISCORD.GG/abc` in a code block", [{ code: "abc", resolvable: true }]],
        ["dsc.gg/abc", [{ code: "abc", resolvable: false }]],
        [
            "discord.gg/a and discord.gg/b",
            [
                { code: "a", resolvable: true },
                { code: "b", resolvable: true },
            ],
        ],
        ["notdiscord.gg/abc", []],
        ["my-dsc.gg/abc", []],
        ["discord.gg/", []],
        ["discord.com/channels/1/2", []],
        ["no links here", []],
    ];
    for (const [text, invites] of table) expect(invitesIn(text)).toEqual(invites);
});

test("a member's ticket subject posted to a queue can't render as a mention, a command or a link", () => {
    const line = QUEUE_COPY.ticket({
        ticketKind: "help",
        subject: "<@&1234> </ban:5678> [here](https://x.test)",
        product: null,
        username: "nina",
        state: "open",
    });
    expect(line).toContain("\\<@&1234\\> \\</ban:5678\\> \\[here\\]\\(https://x.test\\)");
});
