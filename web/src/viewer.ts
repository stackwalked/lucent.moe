import { type Action, isAction } from "@lucent/policy/action-list";
import { can, type Subject } from "@lucent/policy/policy";
import type { WebContract } from "@lucent/rpc/web";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { callPlatform, noteAccount, requestReference } from "./server/platform.ts";

// Who holds the session, as the root route resolves it on every full load. Client navigations
// reuse it until something that changes it (sign-in, sign-out, a step-up, a credential change)
// forgets it. It only steers what a page shows: every server call is decided again by platform.

export type Viewer = z.output<WebContract["session.resolve"]["output"]>;

export type Session =
    | { readonly state: "signed-in"; readonly viewer: Viewer }
    | { readonly state: "signed-out" }
    | { readonly state: "unavailable"; readonly reference: string };

export const fetchSession = createServerFn({ method: "GET" }).handler(
    async (): Promise<Session> => {
        const reply = await callPlatform("session.resolve", {}, { whenSignedOut: "return" });
        if (reply.ok) {
            noteAccount(reply.value.accountId);
            return { state: "signed-in", viewer: reply.value };
        }
        if (reply.error.code === "SESSION_INVALID") return { state: "signed-out" };
        return { state: "unavailable", reference: requestReference() };
    },
);

let remembered: Session | null = null;

export async function loadSession(): Promise<Session> {
    if (typeof document === "undefined") return await fetchSession();
    remembered ??= await fetchSession();
    return remembered;
}

// The page a full load rendered already resolved the session; the browser starts from that.
export function rememberSession(session: Session): void {
    if (typeof document !== "undefined") remembered ??= session;
}

export function forgetSession(): void {
    remembered = null;
}

export function memberOf(session: Session): Viewer | null {
    return session.state === "signed-in" && session.viewer.purpose === "member"
        ? session.viewer
        : null;
}

// What can() needs, from what the viewer says. Permissions web doesn't know yet (platform deployed
// ahead) grant nothing here.
export function subjectOf(viewer: Viewer): Subject {
    const known = viewer.standing.permissions.flatMap((raw): Action[] => {
        return isAction(raw) ? [raw] : [];
    });
    return {
        accountId: viewer.accountId,
        isRoot: viewer.standing.isRoot,
        isActive: true,
        maxRank: viewer.standing.maxRank,
        permissions: new Set(known),
        stepUpAt: viewer.stepUpAt,
        authenticatedAt: viewer.authenticatedAt,
    };
}

export function viewerCan(viewer: Viewer, action: Action): boolean {
    return can(subjectOf(viewer), action);
}
