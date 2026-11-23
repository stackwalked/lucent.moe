import { expect, test } from "bun:test";
import type { ModuleKey } from "@lucent/bundle/fact-set";
import { decideAskedBuilds, decideDataRevisions } from "../src/runtime/revisions.rules.ts";

const GAME: ModuleKey = { nameHash: 0x10n, timeDateStamp: 1, sizeOfImage: 2 };
const LATE: ModuleKey = { nameHash: 0x20n, timeDateStamp: 3, sizeOfImage: 4 };
const OTHER: ModuleKey = { nameHash: 0x10n, timeDateStamp: 1, sizeOfImage: 3 };

const sessions = [
    { id: Uint8Array.of(1), revision: 0n, builds: [GAME] },
    { id: Uint8Array.of(2), revision: 7n, builds: [GAME, LATE] },
    { id: Uint8Array.of(3), revision: 2n, builds: [] },
];

test.each([
    ["a kill switch", { kind: "override" } as const, [1, 8, 3]],
    ["a promotion of a build two run", { kind: "promotion", builds: [GAME] } as const, [1, 8]],
    ["a promotion of a late build", { kind: "promotion", builds: [LATE] } as const, [8]],
    [
        "a promotion of a build differing in size",
        { kind: "promotion", builds: [OTHER] } as const,
        [],
    ],
    ["a promotion listing no build", { kind: "promotion", builds: [] } as const, []],
])("%s raises the revision of exactly the sessions it touches, by one", (_, change, expected) => {
    const plan = decideDataRevisions(sessions, change);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const bumped = plan.value.map((bump) => Number(bump.revision));
    expect(bumped).toEqual(expected);
});

test("a kill switch on a release with no live session raises nothing", () => {
    expect(decideDataRevisions([], { kind: "override" })).toEqual({ ok: true, value: [] });
});

test.each([
    ["a build the start reported", [GAME], [], [GAME], null],
    ["a build already asked", [GAME], [LATE], [LATE], null],
    ["a new late build", [GAME], [], [LATE, GAME], [LATE]],
    ["two new builds, sorted", [], [LATE], [OTHER, GAME], [GAME, OTHER, LATE]],
])("a data request for %s records only what it adds", (_, started, asked, requested, expected) => {
    expect(decideAskedBuilds({ started, asked, requested })).toEqual({
        ok: true,
        value: expected,
    });
});
