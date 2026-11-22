import type { Result } from "@lucent/core/result";
import type { RefusalCode } from "@lucent/wire/refusal";
import type { DbFailure } from "../../db/pool.ts";
import type { OAuthError, TokenSet } from "../../devices/sign-in.ts";
import { type NativeRefusal, refusalResponse } from "./http.ts";

type ServerFault = DbFailure | { readonly code: "RECEIPT_UNREADABLE" };

const FAULT_CODES: ReadonlySet<string> = new Set([
    "STATEMENT_TIMEOUT",
    "SERIALIZATION_FAILURE",
    "UNIQUE_VIOLATION",
    "CHECK_VIOLATION",
    "DB_UNAVAILABLE",
    "RECEIPT_UNREADABLE",
]);

function isFault<E extends { readonly code: string }>(
    error: E | ServerFault,
): error is ServerFault {
    return FAULT_CODES.has(error.code);
}

// A refusal for the loader to show, or the server's own failure as 503.
export function refusalOf(error: { readonly code: RefusalCode } | ServerFault): NativeRefusal {
    if (isFault(error)) return { code: "SERVICE_UNAVAILABLE" };
    return { code: error.code };
}

export function reply<T>(
    result: Result<T, { readonly code: RefusalCode } | ServerFault>,
    respond: (value: T) => Response,
): Response {
    return result.ok ? respond(result.value) : refusalResponse(refusalOf(result.error));
}

export function oauthReply(
    status: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
): Response {
    return Response.json(body, {
        status,
        headers: { "cache-control": "no-store", pragma: "no-cache", ...headers },
    });
}

export function oauthFailure(error: OAuthError | ServerFault): Response {
    if (isFault(error)) return oauthReply(503, { error: "temporarily_unavailable" });
    return oauthReply(error.code === "invalid_client" ? 401 : 400, { error: error.code });
}

export function tokenReply(tokens: TokenSet): Response {
    return oauthReply(200, {
        access_token: tokens.accessToken,
        token_type: "DPoP",
        expires_in: tokens.expiresInSeconds,
        refresh_token: tokens.refreshToken,
    });
}
