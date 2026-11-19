import type { Clock } from "@lucent/core/clock";
import { tryAsync, trySync } from "@lucent/core/contain";
import { z } from "zod";
import type { ReportLine } from "./log.ts";

// POST /_report takes CSP and Trusted Types violations (the Reporting API's JSON) and the errors
// our own browser handler sends. Each becomes one log line of closed fields; a report body never
// reaches the log as it came.

export const REPORT_MAX_BYTES = 4_096;
const MESSAGE_MAX = 300;
const STACK_MAX = 2_000;

const Text = z.string().transform((value) => value.slice(0, MESSAGE_MAX));

const ViolationReport = z.object({
    type: z.enum(["csp-violation", "coep", "deprecation", "intervention"]).or(z.string()),
    url: z.string().optional(),
    body: z
        .object({
            effectiveDirective: Text.optional(),
            blockedURL: Text.optional(),
            documentURL: z.string().optional(),
        })
        .optional(),
});

const BrowserError = z.strictObject({
    kind: z.enum(["render", "hydration", "unhandled"]),
    route: z.string().max(512),
    message: Text,
    stack: z
        .string()
        .transform((value) => value.slice(0, STACK_MAX))
        .nullable(),
    requestId: z.string().max(64).nullable(),
});

// The body as text, or null once it passes `max` bytes: a report is read without trusting
// Content-Length, which a chunked one doesn't have.
export async function readReportBody(req: Request, max: number): Promise<string | null> {
    if (req.body === null) return "";
    const reader = req.body.getReader();
    const read = await tryAsync(
        async () => {
            const chunks: Uint8Array[] = [];
            let total = 0;
            for (;;) {
                const step = await reader.read();
                if (step.done) break;
                total += step.value.byteLength;
                if (total > max) {
                    await reader.cancel();
                    return null;
                }
                chunks.push(step.value);
            }
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return new TextDecoder().decode(merged);
        },
        () => null,
    );
    return read.ok ? read.value : null;
}

function pathOf(url: string | undefined): string {
    if (url === undefined || !URL.canParse(url)) return "/";
    return new URL(url).pathname;
}

export function parseReports(raw: string): readonly ReportLine[] {
    const json = trySync(
        (): unknown => JSON.parse(raw),
        () => null,
    );
    if (!json.ok) return [];
    const ours = BrowserError.safeParse(json.value);
    if (ours.success) {
        return [{ ...ours.data, kind: `browser.${ours.data.kind}` }];
    }
    const theirs = z.array(ViolationReport).max(16).safeParse(json.value);
    if (!theirs.success) return [];
    return theirs.data.map((report) => ({
        kind: report.type,
        route: pathOf(report.body?.documentURL ?? report.url),
        message: [report.body?.effectiveDirective, report.body?.blockedURL]
            .filter((part) => part !== undefined)
            .join(" "),
        stack: null,
        requestId: null,
    }));
}

const DEDUPE_MS = 60_000;

// The same report from the same page, many times a minute, is one problem: logged once.
export function createReportDeduper(clock: Clock): (line: ReportLine) => boolean {
    const seen = new Map<string, number>();
    return (line) => {
        const now = clock.now();
        for (const [key, at] of seen) {
            if (now - at >= DEDUPE_MS) seen.delete(key);
        }
        const key = `${line.kind}|${line.route}|${line.message}`;
        if (seen.has(key)) return false;
        seen.set(key, now);
        return true;
    };
}
