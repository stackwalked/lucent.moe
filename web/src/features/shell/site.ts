import { fetchSite } from "./server.ts";

type Site = Awaited<ReturnType<typeof fetchSite>>;

// Read once per page load: the configuration it comes from does not change while the site runs.
let known: Promise<Site> | null = null;

export function loadSite(): Promise<Site> {
    known ??= fetchSite();
    return known;
}
