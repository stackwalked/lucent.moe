export const AUDIT_COPY = {
    title: "audit",
    search: "search",
    searchHint: "actor: target: op: before:",
    table: "audit log",
    time: "time",
    actor: "actor",
    operation: "operation",
    target: "target",
    detail: "detail",
    empty: "no entries.",
    until: "until",
    renamed: (from: string, to: string) => `${from} → ${to}`,
} as const;
