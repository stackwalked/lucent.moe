import { type Clock, toIsoTimestamp } from "@lucent/core/clock";

export type LogLevel = "info" | "warn" | "error";
export type LogOrigin = "boot" | "gateway" | "platform" | "sync" | "feeds" | "commands";

// A closed set of fields, as platform's: a value reaches the log only through a field named
// here, so an interaction's token or a member's message can't be logged by passing it along.
export type LogFields = {
    readonly origin?: LogOrigin;
    readonly detail?: string;
};

export type Logger = {
    readonly write: (level: LogLevel, msg: string, fields?: LogFields) => void;
};

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
