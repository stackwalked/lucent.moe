import "@tanstack/react-start/server-only";
import { systemClock } from "@lucent/core/clock";
import { invariant, tryAsync } from "@lucent/core/contain";
import { err, type Result } from "@lucent/core/result";
import { systemCryptoRng } from "@lucent/core/rng";
import { type AccountId, ClientInfo, toBase64Url } from "@lucent/core/scalars";
import type { ReplyOf, RpcClient } from "@lucent/rpc/client";
import { RequestId, RPC_HEADERS, toClientHeader } from "@lucent/rpc/contract";
import { LOADER_DOWNLOAD_PATH, type WebContract, webContract } from "@lucent/rpc/web";
import { getGlobalStartContext } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import type { z } from "zod";
import { REFUSALS } from "../copy/refusals.ts";
import { processEnvironment, readWebConfig } from "./config.ts";
import { connectPlatform, connectPlatformStreams, type PlatformGet } from "./connect.ts";
import { clearSessionToken, readSessionToken } from "./cookies.ts";
import { createRequestTrace, type WebRequest } from "./request.ts";
import { toNotFound, toSignIn, toUnavailable } from "./route-control.ts";
import { BUCKETS, type Bucket, createThrottle } from "./throttle.ts";

// The one way web reaches platform (ast-grep keeps the RPC client out of everything else). It
// carries the session, client and request id, applies the per-procedure throttles, and handles
// the refusals no page should handle on its own.

type Name = keyof WebContract & string;
type Input<K extends Name> = z.input<WebContract[K]["input"]>;
// What the gateway itself can answer, besides what platform does.
export type GatewayRefusal = { readonly code: "THROTTLED" } | { readonly code: "SESSION_INVALID" };

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
    if (name.startsWith("reset.password.")) return BUCKETS.passwordReset;
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
// the browser sent to sign in (or, with `whenSignedOut: "return"`, the refusal comes back too,
// for a caller to whom signed out is an ordinary answer). Reads are retried once, which rides out
// platform's epoch handover during a deploy; writes never are.
export async function callPlatform<K extends Name>(
    name: K,
    input: Input<K>,
    options?: { readonly whenSignedOut?: "redirect" | "return" },
): Promise<ReplyOf<WebContract[K]> | Result<never, GatewayRefusal>> {
    const web = currentRequest();
    const bucket = bucketFor(name);
    if (bucket !== null && !web.throttle.take(bucket, web.client.ip)) {
        return err({ code: "THROTTLED" });
    }
    const contract = webContract[name];
    const signedOut = options?.whenSignedOut ?? "redirect";
    const session = contract.session === "none" ? null : readSessionToken();
    if (contract.session !== "none" && session === null) {
        if (signedOut === "return") return err({ code: "SESSION_INVALID" });
        toSignIn();
    }

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
        clearSessionToken();
        if (signedOut === "redirect") toSignIn();
    }
    return reply;
}

// The request's trace learns whose session it carried, for the request log.
export function noteAccount(accountId: AccountId): void {
    currentRequest().trace.setAccount(accountId);
}

// The request id, shown as the support reference on an unexpected failure.
export function requestReference(): string {
    return currentRequest().requestId;
}

// For loaders: what a page can't render becomes the router's 404 or the 503 page; every other
// refusal is the page's to show.
export async function readPlatform<K extends Name>(
    name: K,
    input: Input<K>,
): Promise<ReplyOf<WebContract[K]> | Result<never, GatewayRefusal>> {
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

let streams: PlatformGet | null = null;

function platformStreams(): PlatformGet {
    if (streams !== null) return streams;
    const config = readWebConfig(processEnvironment());
    invariant(config.ok, `web config invalid: ${JSON.stringify(config)}`);
    streams = connectPlatformStreams(config.value.platform, config.value.peerKey);
    return streams;
}

// Long enough for a slow line to take the whole loader; the browser leaving ends it sooner.
const DOWNLOAD_DEADLINE_MS = 10 * 60 * 1_000;
const DOWNLOAD_NAME = "lucent-loader.exe";

// The current loader for the signed-in member, from platform's streaming route and passed on as
// it arrives: web holds neither the file nor anything but the member's own session. Who may have
// it is platform's to decide; anything but the bytes sends the browser back to the download page,
// which says why (or, signed out, on to sign-in).
export async function downloadLoader(signal: AbortSignal): Promise<Response> {
    const web = currentRequest();
    const back = new Response(null, { status: 303, headers: { location: "/download" } });
    const session = readSessionToken();
    if (session === null) return back;
    const startedAt = systemClock.now();
    const reply = await tryAsync(
        () =>
            platformStreams()(
                LOADER_DOWNLOAD_PATH,
                {
                    [RPC_HEADERS.session]: session,
                    [RPC_HEADERS.client]: toClientHeader(web.client),
                    [RPC_HEADERS.request]: web.requestId,
                },
                AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_DEADLINE_MS)]),
            ),
        () => null,
    );
    web.trace.addPlatformTime(systemClock.now() - startedAt);
    const res = reply.ok ? reply.value : null;
    if (res?.status === 200 && res.body !== null) {
        const length = res.headers.get("content-length");
        return new Response(res.body, {
            headers: {
                "content-type": "application/octet-stream",
                "content-disposition": `attachment; filename="${DOWNLOAD_NAME}"`,
                "cache-control": "no-store",
                ...(length === null ? {} : { "content-length": length }),
            },
        });
    }
    await res?.body?.cancel();
    if (res === null || res.status >= 500) {
        return new Response(`${REFUSALS.SERVICE_UNAVAILABLE} reference: ${web.requestId}`, {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
    }
    if (res.status === 401) clearSessionToken();
    return back;
}
