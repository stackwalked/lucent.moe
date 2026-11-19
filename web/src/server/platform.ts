import "@tanstack/react-start/server-only";
import { systemClock } from "@lucent/core/clock";
import { invariant } from "@lucent/core/contain";
import { err, type Result } from "@lucent/core/result";
import { systemCryptoRng } from "@lucent/core/rng";
import { BearerToken, ClientInfo, toBase64Url } from "@lucent/core/scalars";
import type { ReplyOf, RpcClient } from "@lucent/rpc/client";
import { RequestId } from "@lucent/rpc/contract";
import { type WebContract, webContract } from "@lucent/rpc/web";
import { getGlobalStartContext } from "@tanstack/react-start";
import { deleteCookie, getCookie, getRequestHeader } from "@tanstack/react-start/server";
import type { z } from "zod";
import { processEnvironment, readWebConfig } from "./config.ts";
import { connectPlatform } from "./connect.ts";
import { createRequestTrace, type WebRequest } from "./request.ts";
import { toNotFound, toSignIn, toUnavailable } from "./route-control.ts";
import { BUCKETS, type Bucket, createThrottle } from "./throttle.ts";

// The one way web reaches platform (ast-grep keeps the RPC client out of everything else). It
// carries the session, client and request id, applies the per-procedure throttles, and handles
// the refusals no page should handle on its own.

export const SESSION_COOKIE = "__Host-lucent";

type Name = keyof WebContract & string;
type Input<K extends Name> = z.input<WebContract[K]["input"]>;
export type Throttled = { readonly code: "THROTTLED" };

let platform: RpcClient<WebContract> | null = null;

function platformClient(): RpcClient<WebContract> {
    if (platform !== null) return platform;
    const config = readWebConfig(processEnvironment());
    invariant(config.ok, `web config invalid: ${JSON.stringify(config)}`);
    platform = connectPlatform(config.value.platform, config.value.peerKey);
    return platform;
}

// Under `web:dev` Vite serves the request and the entry never ran, so there is no context to
// read: dev gets a fresh request id and its own throttle.
const devThrottle = createThrottle({ clock: systemClock });

function currentRequest(): WebRequest {
    const web = getGlobalStartContext()?.web;
    if (web !== undefined) return web;
    return {
        requestId: RequestId.parse(toBase64Url(systemCryptoRng.fillBytes(new Uint8Array(12)))),
        client: ClientInfo.parse({
            ip: "127.0.0.1",
            userAgent: (getRequestHeader("user-agent") ?? "").slice(0, 512),
        }),
        trace: createRequestTrace(),
        throttle: devThrottle,
    };
}

function bucketFor(name: Name): Bucket | null {
    if (name.startsWith("signIn.")) return BUCKETS.signIn;
    if (name.startsWith("stepUp.")) return BUCKETS.stepUp;
    if (name === "setup.redeem") return BUCKETS.setupRedeem;
    return null;
}

function codeOf(error: unknown): string | null {
    if (typeof error !== "object" || error === null || !("code" in error)) return null;
    return typeof error.code === "string" ? error.code : null;
}

const READ_RETRY_DELAY_MS = 250;

// Refusals come back to the caller to show, except an ended session: the cookie is cleared and
// the browser sent to sign in. Reads are retried once, which rides out platform's epoch handover
// during a deploy; writes never are.
export async function callPlatform<K extends Name>(
    name: K,
    input: Input<K>,
): Promise<ReplyOf<WebContract[K]> | Result<never, Throttled>> {
    const web = currentRequest();
    const bucket = bucketFor(name);
    if (bucket !== null && !web.throttle.take(bucket, web.client.ip)) {
        return err({ code: "THROTTLED" });
    }
    const contract = webContract[name];
    const parsedSession = BearerToken.safeParse(getCookie(SESSION_COOKIE));
    const session =
        contract.session === "none" || !parsedSession.success ? null : parsedSession.data;
    if (contract.session !== "none" && session === null) toSignIn();

    const send = async (): Promise<ReplyOf<WebContract[K]>> => {
        const startedAt = systemClock.now();
        const reply = await platformClient().send(name, input, {
            session,
            client: web.client,
            requestId: web.requestId,
        });
        web.trace.addPlatformTime(systemClock.now() - startedAt);
        return reply;
    };
    let reply = await send();
    if (!reply.ok && contract.effect === "read" && codeOf(reply.error) === "SERVICE_UNAVAILABLE") {
        await Bun.sleep(READ_RETRY_DELAY_MS);
        reply = await send();
    }
    if (!reply.ok && codeOf(reply.error) === "SESSION_INVALID") {
        deleteCookie(SESSION_COOKIE, { path: "/", secure: true });
        toSignIn();
    }
    return reply;
}

// For loaders: what a page can't render becomes the router's 404 or the 503 page; every other
// refusal is the page's to show.
export async function readPlatform<K extends Name>(
    name: K,
    input: Input<K>,
): Promise<ReplyOf<WebContract[K]> | Result<never, Throttled>> {
    const reply = await callPlatform(name, input);
    if (reply.ok) return reply;
    const code = codeOf(reply.error);
    if (code === "NOT_FOUND") toNotFound();
    if (
        code === "SERVICE_UNAVAILABLE" ||
        code === "AUTH_REQUIRED" ||
        code === "INVALID_REQUEST" ||
        code === "UNKNOWN_PROCEDURE" ||
        code === "PAYLOAD_TOO_LARGE"
    ) {
        toUnavailable(currentRequest().requestId);
    }
    return reply;
}
