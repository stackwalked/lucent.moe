import { type Clock, toIsoTimestamp } from "@lucent/core/clock";
import type { AccountId } from "@lucent/core/scalars";

// Paths logged as they are. Anything else is cut to its first segment, so a token in a path
// (`/setup/<token>`) never reaches a log even when a route is added without updating this list.
const LOGGABLE: readonly RegExp[] = [
    /^\/$/,
    /^\/(sign-in|setup|account\/security|_health|_report)$/,
    /^\/admin\/(members\/accounts|members\/roles|system\/audit)$/,
    /^\/admin\/members\/accounts\/acc_[A-Za-z0-9_-]{22}$/,
    /^\/legal\/[a-z-]{1,32}$/,
    /^\/assets\/[A-Za-z0-9._-]{1,128}$/,
];

export function loggablePath(pathname: string): string {
    if (LOGGABLE.some((pattern) => pattern.test(pathname))) return pathname;
    const first = pathname.split("/").find((segment) => segment.length > 0);
    return first === undefined ? "/*" : `/${first}/*`;
}

export type RequestLine = {
    readonly method: string;
    readonly pathname: string;
    readonly status: number;
    readonly ms: number;
    readonly platformMs: number;
    readonly requestId: string;
    readonly accountId: AccountId | null;
};

// One JSON line per request. The account id is enough to correlate with platform's audit; no
// username, email, IP or user agent.
export function formatRequestLine(clock: Clock, line: RequestLine): string {
    const level = line.status >= 500 ? "error" : "info";
    return `${JSON.stringify({
        at: toIsoTimestamp(clock.now()),
        level,
        method: line.method,
        path: loggablePath(line.pathname),
        status: line.status,
        ms: line.ms,
        platformMs: line.platformMs,
        requestId: line.requestId,
        accountId: line.accountId,
    })}\n`;
}

export type ReportLine = {
    readonly kind: string;
    readonly route: string;
    readonly message: string;
    readonly stack: string | null;
    readonly requestId: string | null;
};

export function formatReportLine(clock: Clock, line: ReportLine): string {
    return `${JSON.stringify({
        at: toIsoTimestamp(clock.now()),
        level: "warn",
        msg: "browser report",
        kind: line.kind,
        route: loggablePath(line.route),
        message: line.message,
        stack: line.stack,
        requestId: line.requestId,
    })}\n`;
}

// A failure Start didn't contain itself: the detail goes to the log, the reference to the page.
export function formatFailureLine(
    clock: Clock,
    line: { readonly requestId: string; readonly detail: string },
): string {
    return `${JSON.stringify({
        at: toIsoTimestamp(clock.now()),
        level: "error",
        msg: "unhandled",
        requestId: line.requestId,
        detail: line.detail,
    })}\n`;
}
