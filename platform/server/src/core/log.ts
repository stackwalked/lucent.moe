import { type Clock, toIsoTimestamp } from "./clock.ts";

export type LogLevel = "info" | "warn" | "error";
export type LogOrigin = "boot" | "epoch-guard" | "internal-web";

// A closed set of fields: a value only reaches the log through a field named here, so a request
// body, a token or an email can't be logged by passing an object along.
export type LogFields = {
    readonly origin?: LogOrigin;
    readonly detail?: string;
    readonly requestId?: string | null;
};

// Positive allowlist of safe route shapes. Any path not matched here is truncated to its first
// segment (`/<first>/*`) so bearer tokens in paths (`/setup/<token>`, `/invite/<code>`) never
// reach stdout even if someone forgets to register a new route.
const LOGGABLE_PATTERNS: readonly RegExp[] = [/^\/internal\/web\/rpc$/];

export function loggablePath(rawPathname: string): string {
    for (const pattern of LOGGABLE_PATTERNS) {
        if (pattern.test(rawPathname)) {
            return rawPathname;
        }
    }
    const segments = rawPathname.split("/").filter((part) => part.length > 0);
    const first = segments[0];
    if (first === undefined) {
        return "/*";
    }
    return `/${first}/*`;
}

export type Logger = {
    readonly write: (level: LogLevel, msg: string, fields?: LogFields) => void;
};

// One JSON object per line, for whatever collects the process's stdout.
export function createJsonlLogger(params: {
    readonly clock: Clock;
    readonly sink: (line: string) => void;
}): Logger {
    return {
        write: (level, msg, fields) => {
            const line = { at: toIsoTimestamp(params.clock.now()), level, msg, ...fields };
            params.sink(`${JSON.stringify(line)}\n`);
        },
    };
}

export function writeToStdout(line: string): void {
    process.stdout.write(line);
}
