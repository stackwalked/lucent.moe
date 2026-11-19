// Where to land after signing in, checked every time it's used (the open-redirect defense): one
// leading "/" (never "//" or "/\"), the same origin once resolved, and a page that exists and
// isn't a sign-in or setup page. Anything else lands on "/".

export const SIGN_IN_PAGES: ReadonlySet<string> = new Set(["/sign-in", "/setup"]);

// Route paths as the router spells them: "$param" segments match any one segment.
export function matchesRoute(pathname: string, routes: readonly string[]): boolean {
    const segments = pathname.split("/").filter((s) => s.length > 0);
    return routes.some((route) => {
        const pattern = route.split("/").filter((s) => s.length > 0);
        return (
            pattern.length === segments.length &&
            pattern.every((part, i) => part.startsWith("$") || part === segments[i])
        );
    });
}

export function safeReturnTo(
    raw: string | undefined,
    publicOrigin: string,
    pages: readonly string[],
): string {
    if (
        raw === undefined ||
        !raw.startsWith("/") ||
        raw.startsWith("//") ||
        raw.startsWith("/\\")
    ) {
        return "/";
    }
    if (!URL.canParse(raw, publicOrigin)) return "/";
    const url = new URL(raw, publicOrigin);
    if (url.origin !== publicOrigin) return "/";
    if (SIGN_IN_PAGES.has(url.pathname) || url.pathname.startsWith("/setup/")) return "/";
    if (!matchesRoute(url.pathname, pages)) return "/";
    const q = url.searchParams.get("q");
    return q === null ? url.pathname : `${url.pathname}?q=${encodeURIComponent(q)}`;
}
