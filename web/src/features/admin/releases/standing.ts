export type BuildKey = {
    readonly nameHash: string;
    readonly timeDateStamp: number;
    readonly sizeOfImage: number;
};

// A build as staff compare it with what a module or the fact tooling prints: name hash, then
// TimeDateStamp and SizeOfImage in hex.
export function buildLabel(build: BuildKey): string {
    const hex = (value: number) => value.toString(16).padStart(8, "0");
    return `${build.nameHash}:${hex(build.timeDateStamp)}:${hex(build.sizeOfImage)}`;
}

// Where a set stands against the builds it lists: current for all of them, promotable when none
// runs a higher revision (platform refuses it otherwise), or behind.
export function setStanding(
    set: { readonly revision: number; readonly builds: readonly BuildKey[] },
    builds: readonly {
        readonly build: BuildKey;
        readonly current: { readonly revision: number } | null;
    }[],
): "current" | "promotable" | "behind" {
    const currents = set.builds.map(
        (listed) =>
            builds.find((row) => buildLabel(row.build) === buildLabel(listed))?.current?.revision ??
            null,
    );
    if (currents.every((revision) => revision === set.revision)) return "current";
    return currents.some((revision) => revision !== null && revision > set.revision)
        ? "behind"
        : "promotable";
}
