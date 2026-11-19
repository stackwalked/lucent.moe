import "@tanstack/react-start/server-only";
import { systemClock } from "@lucent/core/clock";
import { BearerToken, type EpochMs } from "@lucent/core/scalars";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import {
    decodeFlow,
    encodeFlow,
    FLOW_MAX_AGE_SECONDS,
    type FlowState,
    flowFrom,
    isEmptyFlow,
} from "./flow.ts";

// The two cookies web keeps. __Host- pins them to this origin (Secure, Path=/, no Domain);
// HttpOnly keeps every token out of reach of the page's JavaScript; SameSite=Lax sends them on a
// link from elsewhere but never on another site's form post (the entry's Origin check is the
// second layer).
export const SESSION_COOKIE = "__Host-lucent";
export const FLOW_COOKIE = "__Host-lucent-flow";

const ATTRIBUTES = { path: "/", secure: true, httpOnly: true, sameSite: "lax" } as const;

export function readSessionToken(): BearerToken | null {
    const parsed = BearerToken.safeParse(getCookie(SESSION_COOKIE));
    return parsed.success ? parsed.data : null;
}

// The cookie lives exactly as long as platform's session: one sign-in, never extended.
export function writeSessionToken(token: BearerToken, expiresAt: EpochMs): void {
    const maxAge = Math.max(0, Math.floor((expiresAt - systemClock.now()) / 1_000));
    setCookie(SESSION_COOKIE, token, { ...ATTRIBUTES, maxAge });
}

export function clearSessionToken(): void {
    deleteCookie(SESSION_COOKIE, ATTRIBUTES);
}

export function readFlow(): FlowState {
    return decodeFlow(getCookie(FLOW_COOKIE));
}

// Fields set to null are removed; an empty flow removes the cookie.
export function patchFlow(
    patch: { readonly [K in keyof FlowState]?: FlowState[K] | null },
): FlowState {
    const merged = { ...readFlow(), ...patch };
    const state = flowFrom(
        Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null)),
    );
    if (isEmptyFlow(state)) deleteCookie(FLOW_COOKIE, ATTRIBUTES);
    else setCookie(FLOW_COOKIE, encodeFlow(state), { ...ATTRIBUTES, maxAge: FLOW_MAX_AGE_SECONDS });
    return state;
}
