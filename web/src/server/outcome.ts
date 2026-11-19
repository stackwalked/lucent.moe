import type { RefusalCode } from "../copy/refusals.ts";
import { UNEXPECTED } from "../copy/refusals.ts";
import { requestReference } from "./platform.ts";

// What a server function hands back to a form: the value, or the refusal to show. Unexpected
// failures carry the request id, which the page shows as the support reference and the logs
// carry too.
export type Refused = {
    readonly code: RefusalCode;
    readonly reference: string | null;
    readonly reason?: "too_short" | "too_long";
};

export type Outcome<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly refused: Refused };

export function done<T>(value: T): Outcome<T> {
    return { ok: true, value };
}

export function refuse(error: {
    readonly code: RefusalCode;
    readonly reason?: string;
}): Outcome<never> {
    const reason =
        error.reason === "too_short" || error.reason === "too_long" ? error.reason : undefined;
    return {
        ok: false,
        refused: {
            code: error.code,
            reference: UNEXPECTED.has(error.code) ? requestReference() : null,
            ...(reason === undefined ? {} : { reason }),
        },
    };
}
