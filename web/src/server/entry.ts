import type { Clock } from "@lucent/core/clock";
import { containBoundary } from "@lucent/core/contain";
import type { CryptoRng } from "@lucent/core/rng";
import { toBase64Url } from "@lucent/core/scalars";
import { RequestId } from "@lucent/rpc/contract";
import { cameThroughProxy, clientOf, isCrossSiteWrite, isOurHost } from "./gates.ts";
import { REPORT_PATH, securityHeaders, withHeaders } from "./headers.ts";
import { formatFailureLine, formatReportLine, formatRequestLine } from "./log.ts";
import { createReportDeduper, parseReports, REPORT_MAX_BYTES, readReportBody } from "./report.ts";
import { createRequestTrace, type StartRequestContext } from "./request.ts";
import { BUCKETS, type Throttle } from "./throttle.ts";

// Start's handler from the build (dist/server/server.js), given each request's context.
export type StartHandler = (
    req: Request,
    opts: { readonly context: StartRequestContext },
) => Promise<Response>;

// A built file under dist/client for an /assets/ path, or null when there's none.
export type AssetServer = (pathname: string) => Promise<Response | null>;

export type WebEntry = (req: Request, peerIp: string | null) => Promise<Response>;

function text(status: number, body: string): Response {
    return new Response(body, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
}

// When Start itself fails there's no layout to render into: a bare page with the reference.
function failurePage(requestId: string): Response {
    return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>error</title><p>error. reference: ${requestId}</p></html>`,
        {
            status: 500,
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        },
    );
}

export function createWebEntry(deps: {
    readonly publicOrigin: string;
    readonly clock: Clock;
    readonly rng: CryptoRng;
    readonly start: StartHandler;
    readonly assets: AssetServer;
    readonly checkPlatform: () => Promise<boolean>;
    readonly throttle: Throttle;
    readonly sink: (line: string) => void;
}): WebEntry {
    const firstReport = createReportDeduper(deps.clock);

    const report = async (req: Request, ip: string): Promise<Response> => {
        if (req.method !== "POST") return text(405, "method not allowed.");
        // Reports come from our own pages only. Browsers send them without credentials and not
        // always with an Origin, so a missing one is let through; a foreign one never is.
        const origin = req.headers.get("origin");
        const site = req.headers.get("sec-fetch-site");
        if ((origin !== null && origin !== deps.publicOrigin) || site === "cross-site") {
            return text(403, "forbidden.");
        }
        if (!deps.throttle.take(BUCKETS.report, ip)) return text(429, "too many requests.");
        const body = await readReportBody(req, REPORT_MAX_BYTES);
        if (body === null) return text(413, "too large.");
        for (const line of parseReports(body)) {
            if (firstReport(line)) deps.sink(formatReportLine(deps.clock, line));
        }
        return new Response(null, { status: 204 });
    };

    const route = async (
        req: Request,
        url: URL,
        context: StartRequestContext,
    ): Promise<{ readonly res: Response; readonly page: boolean }> => {
        const { client, requestId } = context.web;
        if (url.pathname === "/_health") {
            if (cameThroughProxy(req)) return { res: text(404, "not found."), page: false };
            if (!url.searchParams.has("deep")) return { res: text(200, "ok"), page: false };
            const up = await deps.checkPlatform();
            return { res: text(up ? 200 : 503, up ? "ok" : "platform unavailable"), page: false };
        }
        if (!isOurHost(req, deps.publicOrigin)) {
            return { res: text(421, "misdirected request."), page: false };
        }
        if (url.pathname === REPORT_PATH) return { res: await report(req, client.ip), page: false };
        if (isCrossSiteWrite(req, deps.publicOrigin)) {
            return { res: text(403, "forbidden."), page: false };
        }
        if (!deps.throttle.take(BUCKETS.overall, client.ip)) {
            return { res: text(429, "too many requests."), page: false };
        }
        if (url.pathname.startsWith("/assets/")) {
            // Source maps are built and kept, never served.
            const asset = url.pathname.endsWith(".map") ? null : await deps.assets(url.pathname);
            return { res: asset ?? text(404, "not found."), page: false };
        }
        const started = await containBoundary({
            run: () => deps.start(req, { context }),
            onUnhandled: (detail) => {
                deps.sink(formatFailureLine(deps.clock, { requestId, detail }));
                return Promise.resolve(failurePage(requestId));
            },
        });
        const res = new Response(started.body, started);
        res.headers.set("cache-control", "no-store");
        return { res, page: true };
    };

    return async (req, peerIp) => {
        const startedAt = deps.clock.now();
        const url = new URL(req.url);
        const context: StartRequestContext = {
            nonce: toBase64Url(deps.rng.fillBytes(new Uint8Array(16))),
            web: {
                requestId: RequestId.parse(toBase64Url(deps.rng.fillBytes(new Uint8Array(12)))),
                client: clientOf(req, peerIp),
                trace: createRequestTrace(),
                throttle: deps.throttle,
            },
        };
        const { res, page } = await route(req, url, context);
        const done = withHeaders(res, securityHeaders(page ? context.nonce : null));
        const traced = context.web.trace.read();
        deps.sink(
            formatRequestLine(deps.clock, {
                method: req.method,
                pathname: url.pathname,
                status: done.status,
                ms: deps.clock.now() - startedAt,
                platformMs: traced.platformMs,
                requestId: context.web.requestId,
                accountId: traced.accountId,
            }),
        );
        return done;
    };
}
