import { err, ok, type Result } from "@lucent/core/result";

// Volume limits: what one account may have or do, so a single account cannot flood the queue,
// the feeds. Each is decided from a count the writer reads under the
// account's lock, so two requests of one account cannot both slip under it.
export const MAX_OPEN_REPORTS = 20;
export const MAX_POSTS_PER_WINDOW = 10;
export const POST_WINDOW_MS = 60_000;

export type LimitRefusal = {
    readonly code: "LIMIT_REACHED";
    readonly limit: "reports" | "posts";
};

function below(
    count: number,
    max: number,
    limit: LimitRefusal["limit"],
): Result<null, LimitRefusal> {
    return count < max ? ok(null) : err({ code: "LIMIT_REACHED", limit });
}

// Reports of the reporter's that staff have not closed yet.
export function decideReportLimit(openReports: number): Result<null, LimitRefusal> {
    return below(openReports, MAX_OPEN_REPORTS, "reports");
}

// Comments and shouts together, over the last POST_WINDOW_MS.
export function decidePostRate(recentPosts: number): Result<null, LimitRefusal> {
    return below(recentPosts, MAX_POSTS_PER_WINDOW, "posts");
}
