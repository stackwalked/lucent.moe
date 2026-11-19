import { ClientInfo } from "@lucent/core/scalars";

// The checks every request passes before Start sees it. Each is a plain function of the request,
// so the entry reads as their sequence.

// Caddy sets X-Forwarded-For on everything it proxies, and strips any a client sent; a request
// without it reached the socket directly (the container health check).
export function cameThroughProxy(req: Request): boolean {
    return req.headers.has("x-forwarded-for");
}

// A Host other than ours is a misrouted or rebinding request: 421, never served.
export function isOurHost(req: Request, publicOrigin: string): boolean {
    return req.headers.get("host") === new URL(publicOrigin).host;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

// CSRF, behind SameSite=Lax: a request that can change state must say it comes from our own
// pages. Browsers always send Origin on such requests; Sec-Fetch-Site where they support it.
export function isCrossSiteWrite(req: Request, publicOrigin: string): boolean {
    if (SAFE_METHODS.has(req.method)) return false;
    if (req.headers.get("origin") !== publicOrigin) return true;
    const site = req.headers.get("sec-fetch-site");
    return site !== null && site !== "same-origin";
}

const USER_AGENT_MAX = 512;

// The client as Caddy saw it: the last X-Forwarded-For entry is the one Caddy appended (earlier
// ones are whatever the client claimed). Without a proxy, the socket's peer.
export function clientOf(req: Request, peerIp: string | null): ClientInfo {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, USER_AGENT_MAX);
    for (const ip of [forwarded, peerIp, "0.0.0.0"]) {
        const parsed = ClientInfo.safeParse({ ip, userAgent });
        if (parsed.success) return parsed.data;
    }
    return ClientInfo.parse({ ip: "0.0.0.0", userAgent: "" });
}
