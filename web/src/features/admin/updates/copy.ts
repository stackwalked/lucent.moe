export const UPDATES_COPY = {
    title: "update days",
    builds: "builds",
    product: "product",
    build: "build",
    reported: "first reported",
    covered: "covered",
    latency: "latency",
    waiting: (duration: string) => `waiting ${duration}`,
    none: "not yet",
    truncated: "latest 100 builds",
    nothingReported: "no builds reported",
    duration: (ms: number) => {
        const minutes = Math.floor(ms / 60_000);
        if (minutes < 1) return "under a minute";
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
        return `${Math.floor(hours / 24)} days`;
    },
} as const;
