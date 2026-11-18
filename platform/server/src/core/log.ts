export type LogLevel = "info" | "warn" | "error";
export type LogOrigin = "internal-web";

export type LogFields = {
    readonly origin?: LogOrigin;
    readonly detail?: string;
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
