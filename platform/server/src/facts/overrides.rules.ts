import { err, ok, type Result } from "@lucent/core/result";

// A kill switch forces one feature or capability of one module release off for every session on
// it, with no offline key. Each change gives the release's override document its next revision.

export type OverrideKind = "feature" | "capability";

export type OverrideTarget = { readonly kind: OverrideKind; readonly key: bigint };

// What the new revision's document says is off: each list sorted ascending, as the document
// carries it.
export type OffAfter = {
    readonly features: readonly bigint[];
    readonly capabilities: readonly bigint[];
};

export type OverridePlan =
    | { readonly change: "none" }
    | { readonly change: "set" | "clear"; readonly revision: bigint; readonly off: OffAfter };

const ascending = (left: bigint, right: bigint) => (left < right ? -1 : left > right ? 1 : 0);

function offAfter(
    current: readonly OverrideTarget[],
    target: OverrideTarget,
    change: "set" | "clear",
): OffAfter {
    const others = current.filter(
        (switched) => !(switched.kind === target.kind && switched.key === target.key),
    );
    const switched = change === "set" ? [...others, target] : others;
    const keysOf = (kind: OverrideKind) =>
        switched
            .filter((entry) => entry.kind === kind)
            .map((entry) => entry.key)
            .sort(ascending);
    return { features: keysOf("feature"), capabilities: keysOf("capability") };
}

// Only what the release's manifest declares can be switched; switching to the state it is
// already in changes nothing and takes no revision.
export function decideOverrideChange(params: {
    readonly known: {
        readonly features: readonly bigint[];
        readonly capabilities: readonly bigint[];
    };
    readonly current: readonly OverrideTarget[];
    readonly revision: bigint | null;
    readonly target: OverrideTarget;
    readonly off: boolean;
}): Result<OverridePlan, { readonly code: "UNKNOWN_TARGET" }> {
    const { target } = params;
    const declared = target.kind === "feature" ? params.known.features : params.known.capabilities;
    if (!declared.includes(target.key)) return err({ code: "UNKNOWN_TARGET" });
    const isOff = params.current.some(
        (switched) => switched.kind === target.kind && switched.key === target.key,
    );
    if (isOff === params.off) return ok({ change: "none" });
    const change = params.off ? "set" : "clear";
    return ok({
        change,
        revision: (params.revision ?? 0n) + 1n,
        off: offAfter(params.current, target, change),
    });
}
