export const SHOUTS_COPY = {
    none: "no shouts",
    list: "shouts",
    body: "shout",
    delete: "delete",
    more: "more",
    unknownAuthor: "—",
    usage: "use /purge <username> or /purge <1 to 100>",
    purgeTitle: (target: string) => `purge ${target}?`,
    purge: "purge",
    cancel: "cancel",
    lastShouts: (n: number) => `the last ${n}`,
} as const;
