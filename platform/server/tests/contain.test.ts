import { expect, test } from "bun:test";
import {
    containBoundary,
    invariant,
    raiseInvariant,
    tryAsync,
    trySync,
} from "../src/core/contain.ts";

test("an invariant defect passes through trySync to the boundary instead of becoming an err", async () => {
    const outcome = await containBoundary({
        run: () =>
            Promise.resolve(
                trySync(
                    () => invariant(false, "corrupt internal table"),
                    () => "SWALLOWED" as const,
                ),
            ),
        onUnhandled: (_detail, failureKind) => failureKind,
    });
    expect(outcome).toBe("defect");
});

test("an invariant defect raised after an await passes through tryAsync to the boundary", async () => {
    const outcome = await containBoundary({
        run: async () =>
            await tryAsync(
                async () => {
                    await Promise.resolve();
                    return raiseInvariant("impossible slot transition");
                },
                () => "SWALLOWED" as const,
            ),
        onUnhandled: (detail, failureKind) => `${failureKind}: ${detail}`,
    });
    expect(outcome).toBe("defect: invariant violation: impossible slot transition");
});
