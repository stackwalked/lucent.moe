export const AUDIT_COPY = {
    unconfirmedMail: "provider acceptance unconfirmed",
    refusedMail: "provider refused the request",
    title: "audit",
    search: "search",
    searchHint: "actor: target: op: before:",
    table: "audit log",
    time: "time",
    actor: "actor",
    operation: "operation",
    target: "target",
    detail: "detail",
    empty: "no entries",
    until: "until",
    renamed: (from: string, to: string) => `${from} → ${to}`,
    seal: (product: string, channel: string, number: string, previous: string | null) =>
        previous === null
            ? `${product} ${channel}: seal ${number}`
            : `${product} ${channel}: seal ${previous} → ${number}`,
    factSet: (revision: number, builds: number) =>
        `revision ${revision}, ${builds === 1 ? "1 build" : `${builds} builds`}`,
} as const;
