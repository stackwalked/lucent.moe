export const SYSTEM_COPY = {
    title: "system",
    service: "service",
    epoch: "epoch",
    schema: "schema",
    schemaCurrent: (version: number) => `${version}, as this build expects`,
    schemaApart: (database: number, build: number) =>
        `database at ${database}, this build at ${build}`,
    mail: "mail waiting",
    mailCounts: (pending: number, sending: number) => `${pending} queued, ${sending} sending`,
    oldestDue: "oldest due",
    none: "none",
    artifacts: "artifacts",
    noArtifacts: "no loaders' listener on this server",
    artifactsUnreadable: "the artifact directory can't be read",
    artifactSize: (files: number, size: string) =>
        `${files} ${files === 1 ? "file" : "files"}, ${size}`,
    jobs: "jobs",
    noJobs: "no job has run yet.",
    job: "job",
    lastRun: "last run",
    duration: "took",
    state: "state",
    ok: "ok",
    failed: "failed",
    lastFailure: "last failure",
    connections: "database connections",
    application: "application",
    unnamed: "unnamed",
    total: "open",
    active: "active",
    idleInTransaction: "idle in a transaction",
    milliseconds: (ms: number) => `${ms} ms`,
    bytes: (bytes: number) => {
        if (bytes < 1_024) return `${bytes} b`;
        const units = ["kb", "mb", "gb", "tb"] as const;
        let value = bytes / 1_024;
        let unit = 0;
        while (value >= 1_024 && unit < units.length - 1) {
            value /= 1_024;
            unit += 1;
        }
        return `${value.toFixed(1)} ${units[unit]}`;
    },
} as const;

export const USAGE_COPY = {
    title: "usage",
    window: "window",
    from: "from",
    until: "until",
    weeks: "weekly active accounts",
    weeksNote:
        "an account counts in a week when one of its sessions ran in it. weeks run monday to sunday, utc.",
    week: "week",
    isoWeek: (year: number, week: number) => `${year} week ${week}`,
    product: "product",
    accounts: "accounts",
    noSessions: "no sessions in these weeks.",
    releases: "sessions per release",
    channel: "channel",
    release: "release",
    sessions: "sessions",
} as const;
