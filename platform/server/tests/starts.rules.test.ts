import { expect, test } from "bun:test";
import { ProductDefinition } from "@lucent/catalog/product";
import { ChannelId, EpochMs } from "@lucent/core/scalars";
import {
    decideNeededFacts,
    decideStart,
    decideStartAccess,
    decideStartDevice,
    decideStartLoader,
    decideStartOpen,
    decideStartProduct,
    decideStartRelease,
    decideStartReplay,
    decideStartStillOpen,
} from "../src/runtime/starts.rules.ts";

function definition(kind: string, state: string): ProductDefinition {
    return ProductDefinition.parse({
        id: "cs2",
        name: "Counter-Strike 2",
        kind,
        channels: ["stable"],
        concurrentSlots: 1,
        state,
    });
}

test.each([
    [null, "DEVICE_REVOKED"],
    [100, "DEVICE_REVOKED"],
    ["live", null],
] as const)("only an enrolled, unrevoked PC may start: %s", (device, expected) => {
    const r = decideStartDevice(
        device === null
            ? null
            : {
                  id: Uint8Array.of(1),
                  jkt: "jkt",
                  revokedAt: device === "live" ? null : EpochMs.parse(device),
              },
    );
    expect(r.ok ? null : r.error.code).toBe(expected);
});
// What a start on each product answers at the product step, and over both steps: a product that
// passes the first is refused, if at all, only at the release step.
test.each([
    ["cs2", "module", "live", null, null],
    ["cs2", "module", "seed", null, null],
    ["cs2", "module", "retired", null, "RELEASE_UNAVAILABLE"],
    ["cs2", "module", "announced", "NOT_FOUND", "NOT_FOUND"],
    ["cs2", "standalone", "live", "NOT_FOUND", "NOT_FOUND"],
    ["osu", "module", "live", "NOT_FOUND", "NOT_FOUND"],
    ["Not A Product!", "module", "live", "NOT_FOUND", "NOT_FOUND"],
] as const)(
    "an unopened product is unknown and a retired one has no release: %s as a %s, %s",
    (requested, kind, state, atProduct, overall) => {
        const product = definition(kind, state);
        const catalog = new Map([[product.id, product]]);
        const selected = decideStartProduct(catalog, requested);
        expect(selected.ok ? null : selected.error.code).toBe(atProduct);
        if (selected.ok) {
            const open = decideStartOpen(selected.value);
            expect<string | null>(open.ok ? null : open.error.code).toBe(overall);
        }
        const still = decideStartStillOpen(catalog, requested);
        expect(still.ok ? null : still.error.code).toBe(overall);
    },
);
test.each([
    [false, "RELEASE_UNAVAILABLE"],
    [true, null],
] as const)("a start needs a promoted release: %s", (promoted, expected) => {
    const bytes = Uint8Array.of(1);
    const r = decideStartRelease(
        promoted ? { id: bytes, seal: bytes, number: 1n, hasContainer: true } : null,
    );
    expect(r.ok ? null : r.error.code).toBe(expected);
});

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
