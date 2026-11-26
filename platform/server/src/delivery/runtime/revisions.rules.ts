import type { ModuleKey } from "@lucent/bundle/fact-set";
import { ok, type Result } from "@lucent/core/result";

// A session's data revision rises when what the server would send it changes: a kill switch on its
// release changes the override document every session there holds, and a promotion changes the
// set of the builds it lists, which matters only to sessions that run one of them.

export type RevisionedSession = {
    readonly id: Uint8Array;
    readonly revision: bigint;
    // The builds the start reported and those the data route was asked for since.
    readonly builds: readonly ModuleKey[];
};

export type DataChange =
    | { readonly kind: "override" }
    | { readonly kind: "promotion"; readonly builds: readonly ModuleKey[] };

export type RevisionBump = { readonly id: Uint8Array; readonly revision: bigint };

function sameBuild(left: ModuleKey, right: ModuleKey): boolean {
    return (
        left.nameHash === right.nameHash &&
        left.timeDateStamp === right.timeDateStamp &&
        left.sizeOfImage === right.sizeOfImage
    );
}

// The live sessions of the changed release, in the order they were locked; untouched ones keep
// their revision.
export function decideDataRevisions(
    sessions: readonly RevisionedSession[],
    change: DataChange,
): Result<readonly RevisionBump[], never> {
    const touches = (session: RevisionedSession): boolean =>
        change.kind === "override" ||
        session.builds.some((build) => change.builds.some((moved) => sameBuild(build, moved)));
    return ok(
        sessions
            .filter(touches)
            .map((session) => ({ id: session.id, revision: session.revision + 1n })),
    );
}

// The builds a data request adds to those the session already runs, sorted as the wire sorts
// module lists; null when it adds none.
export function decideAskedBuilds(params: {
    readonly started: readonly ModuleKey[];
    readonly asked: readonly ModuleKey[];
    readonly requested: readonly ModuleKey[];
}): Result<readonly ModuleKey[] | null, never> {
    const known = [...params.started, ...params.asked];
    const added = params.requested.filter((build) => !known.some((seen) => sameBuild(seen, build)));
    if (added.length === 0) return ok(null);
    const merged = [...params.asked, ...added].sort(
        (a, b) =>
            (a.nameHash < b.nameHash ? -1 : a.nameHash > b.nameHash ? 1 : 0) ||
            a.timeDateStamp - b.timeDateStamp ||
            a.sizeOfImage - b.sizeOfImage,
    );
    return ok(merged);
}
