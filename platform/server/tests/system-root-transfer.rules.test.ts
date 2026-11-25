import { expect, test } from "bun:test";
import { AccountId } from "@lucent/core/scalars";
import { decideRootTransfer, type RootTransferParty } from "../src/system/root-transfer.rules.ts";

const party = (id: string, over: Partial<RootTransferParty> = {}): RootTransferParty => ({
    id: AccountId.parse(`acc_${id.padEnd(22, "0")}`),
    status: "active",
    isLocked: false,
    hasPasskey: true,
    ...over,
});
const root = party("root");

test.each([
    ["there is no root", null, party("heir"), "NO_ROOT"],
    ["the target does not exist", root, null, "NOT_FOUND"],
    ["the target is root already", root, root, "ALREADY_ROOT"],
    ["the target is suspended", root, party("heir", { status: "suspended" }), "TARGET_SUSPENDED"],
    ["the target is locked", root, party("heir", { isLocked: true }), "TARGET_LOCKED"],
    [
        "the target has no passkey to step up with",
        root,
        party("heir", { hasPasskey: false }),
        "TARGET_NO_PASSKEY",
    ],
    ["the target is active, unlocked and has a passkey", root, party("heir"), null],
] as const)("root transfer when %s", (_, from, target, refusal) => {
    const decided = decideRootTransfer({ root: from, target });
    expect(decided.ok ? null : decided.error.code).toBe(refusal);
});
