import { expect, test } from "bun:test";
import { ChannelId, EpochMs } from "@lucent/core/scalars";
import {
    decideNeededFacts,
    decideStart,
    decideStartAccess,
    decideStartLoader,
    decideStartReplay,
} from "../src/runtime/starts.rules.ts";

test.each([
    [false, "invalid channel!", "ENTITLEMENT_INACTIVE"],
    [true, "beta", "CHANNEL_NOT_ALLOWED"],
    [true, "stable", ChannelId.parse("stable")],
] as const)(
    "entitlement precedes channel selection (%s, %s)",
    (isEntitled, requested, expected) => {
        const r = decideStartAccess(
            { isEntitled, channels: [ChannelId.parse("stable")], features: "*" },
            requested,
        );
        expect(r.ok ? r.value : r.error.code).toBe(expected);
    },
);
test.each([
    [null, "RELEASE_UNAVAILABLE"],
    [1, "LOADER_UPDATE_REQUIRED"],
    [2, null],
] as const)("only the current loader may start: %s", (current, expected) => {
    const r = decideStartLoader(current === null ? null : Uint8Array.of(current), Uint8Array.of(2));
    expect(r.ok ? null : r.error.code).toBe(expected);
});
test.each([
    [[], []],
    [[1n], [1n]],
    [
        [1n, 2n],
        [1n, 2n],
    ],
] as const)(
    "core facts are required only when all their modules are reported: %p",
    (reported, expected) => {
        const facts = [
            { key: 1n, kind: 0, module: 1n },
            { key: 2n, kind: 0, module: 2n },
            { key: 3n, kind: 0, module: 1n },
        ];
        const capabilities = [
            { key: 4n, level: "core", members: [1n] },
            { key: 5n, level: "core", members: [1n, 2n] },
            { key: 6n, level: "optional", members: [3n] },
        ] as const;
        expect(
            decideNeededFacts(
                { facts, capabilities },
                reported.map((nameHash) => ({ nameHash, timeDateStamp: 1, sizeOfImage: 1 })),
            ),
        ).toEqual({ ok: true, value: new Set(expected) });
    },
);
test.each([
    [false, "GAME_BUILD_UNSUPPORTED"],
    [true, EpochMs.parse(110)],
] as const)(
    "a start with core coverage %s returns a refusal or its deadline",
    (coreFacts, expected) => {
        const r = decideStart({ coreFacts }, EpochMs.parse(100), 10);
        expect(r.ok ? r.value : r.error.code).toBe(expected);
    },
);
test.each([
    [99, false],
    [100, false],
    [101, true],
] as const)("a start expiring at %i can be replayed only before expiry", (expires, allowed) => {
    const bytes = Uint8Array.of(1);
    expect(
        decideStartReplay(
            bytes,
            {
                expires_at: EpochMs.parse(expires),
                consumed_at: null,
                container_key: bytes,
                seal: bytes,
            },
            EpochMs.parse(100),
        ).ok,
    ).toBe(allowed);
});
