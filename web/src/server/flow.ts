import { trySync } from "@lucent/core/contain";
import { BearerToken, toBase64Url } from "@lucent/core/scalars";
import { z } from "zod";

// What __Host-lucent-flow holds between requests: platform's flow tokens for what's in progress,
// the setup link's token, where to land after signing in, and the username to fill in there.
// It isn't signed (web holds no keys): the tokens are platform's own 256-bit secrets, so an edited
// one is only FLOW_INVALID, and returnTo is checked every time it's used.
export const FlowState = z.object({
    signIn: BearerToken.optional(),
    passkey: BearerToken.optional(),
    stepUp: BearerToken.optional(),
    register: BearerToken.optional(),
    setup: BearerToken.optional(),
    returnTo: z.string().max(512).optional(),
    username: z.string().max(64).optional(),
    // The OAuth round trip to Discord: the state sent out, and what the answer is for.
    discordState: BearerToken.optional(),
    discordFor: z.enum(["apply", "account"]).optional(),
});
export type FlowState = z.output<typeof FlowState>;

export const FLOW_MAX_AGE_SECONDS = 10 * 60;

export function encodeFlow(state: FlowState): string {
    return toBase64Url(new TextEncoder().encode(JSON.stringify(state)));
}

// Anything that doesn't parse is no flow at all: never an error, never trusted.
export function decodeFlow(raw: string | undefined): FlowState {
    if (raw === undefined || raw.length > 4_096) return {};
    const decoded = trySync(
        (): unknown =>
            JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                    Uint8Array.fromBase64(raw, { alphabet: "base64url" }),
                ),
            ),
        () => null,
    );
    return decoded.ok ? flowFrom(decoded.value) : {};
}

export function flowFrom(value: unknown): FlowState {
    const parsed = FlowState.safeParse(value);
    return parsed.success ? parsed.data : {};
}

export function isEmptyFlow(state: FlowState): boolean {
    return Object.values(state).every((value) => value === undefined);
}
