const hex32 = (value: number) => `0x${value.toString(16).padStart(8, "0")}`;

export const CRASHES_COPY = {
    title: "crashes",
    search: "search",
    searchHint: "product: release:",
    table: "crashes by release and place",
    release: "release",
    where: "where",
    exception: "exception",
    frames: "frames",
    crashes: "crashes",
    first: "first",
    last: "last",
    empty: "no crashes.",
    noFrames: "—",
    releaseName: (product: string, channel: string, seal: string | null) =>
        seal === null ? `${product} ${channel}` : `${product} ${channel} #${seal}`,
    // A module hash of zeros is the module's own image.
    place: (moduleHash: string, rva: number) =>
        /^0+$/.test(moduleHash) ? `ours + ${hex32(rva)}` : `${moduleHash} + ${hex32(rva)}`,
    hex: hex32,
} as const;
