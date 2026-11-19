import { type ClientInfo, toBase64Url } from "@lucent/core/scalars";
import { z } from "zod";
// 43 base64url characters hold 256 bits, what `openssl rand -base64 32` produces; a shorter key
// cannot carry that strength in any printable alphabet we would generate it in. Visible ASCII
// only: HTTP trims header whitespace, so a key with an edge space could never match.
export const MIN_PEER_KEY_LENGTH = 43;
const PEER_KEY_ALPHABET = /^[\x21-\x7e]+$/;

export function isStrongPeerKey(key: string): boolean {
    return key.length >= MIN_PEER_KEY_LENGTH && PEER_KEY_ALPHABET.test(key);
}

// What travels beside a call's input, as HTTP headers.
export const RPC_HEADERS = {
    session: "lucent-session",
    client: "lucent-client",
    request: "lucent-request",
} as const;
// Names one browser request across web's and platform's logs; web shows it as the support
// reference when something fails unexpectedly.
export const RequestId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .brand<"RequestId">();
export type RequestId = z.output<typeof RequestId>;

export const TransportRefusal = z.discriminatedUnion("code", [
    z.strictObject({ code: z.literal("AUTH_REQUIRED") }),
    z.strictObject({ code: z.literal("PAYLOAD_TOO_LARGE") }),
    z.strictObject({ code: z.literal("INVALID_REQUEST"), detail: z.string() }),
    z.strictObject({ code: z.literal("UNKNOWN_PROCEDURE") }),
    z.strictObject({ code: z.literal("SERVICE_UNAVAILABLE") }),
]);
export type TransportRefusal = z.output<typeof TransportRefusal>;

// Which browser session a procedure runs for. The mount refuses a call that lacks the token
// before any handler runs; the handler still locks and checks the session in its own
// transaction, which is what decides.
export type SessionNeed = "none" | "member" | "setup" | "either";

export type ProcedureContract = {
    readonly session: SessionNeed;
    readonly input: z.ZodType;
    readonly output: z.ZodType;
    readonly error: z.ZodType;
};
export type ContractMap = Readonly<Record<string, ProcedureContract>>;

export function defineContract<const Contracts extends ContractMap>(
    contracts: Contracts,
): Contracts {
    return contracts;
}

// base64url of `{ ip, userAgent }` as JSON: a user agent may hold characters a header can't.
export function toClientHeader(client: ClientInfo): string {
    return toBase64Url(new TextEncoder().encode(JSON.stringify(client)));
}
