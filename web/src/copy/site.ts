import { SHARED_COPY } from "./shared.ts";

// Words that belong to the site rather than a feature: the frame's own pages and titles.
export const SITE_COPY = {
    name: "lucent.moe",
    brand: "lucent",
    pageTitle: (page: string) => `${page} · lucent.moe`,
    notFound: SHARED_COPY.notFound,
    home: "home",
    error: "error",
    unavailable: "unavailable",
    reference: "reference",
    retry: "retry",
} as const;
