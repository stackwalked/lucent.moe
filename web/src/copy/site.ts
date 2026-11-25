// Words that belong to the site rather than a feature: the frame's own pages and titles.
export const SITE_COPY = {
    name: "lucent.moe",
    pageTitle: (page: string) => `${page} · lucent.moe`,
    notFound: "not found",
    home: "home",
    error: "error.",
    unavailable: "unavailable.",
    reference: "reference",
    retry: "retry",
} as const;
