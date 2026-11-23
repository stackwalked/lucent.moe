export const PRIVACY_TITLE = "privacy";
export const PRIVACY_COPY = {
    standing: "posting",
    clear: "you can post everywhere.",
    restricted: "posting restrictions on your account",
    muted: "muted: you can't comment or shout",
    barred: "barred: you can't post",
    everywhere: "everywhere",
    inProduct: (product: string) => `in ${product}`,
    untilLifted: "until staff lift it",
    until: "until",
    kind: "restriction",
    scope: "where",
    ends: "ends",
} as const;
