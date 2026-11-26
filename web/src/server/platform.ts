import "@tanstack/react-start/server-only";
import { systemClock } from "@lucent/core/clock";
import { invariant, tryAsync } from "@lucent/core/contain";
import { err, type Result } from "@lucent/core/result";
import { systemCryptoRng } from "@lucent/core/rng";
import { type AccountId, ClientInfo, toBase64Url } from "@lucent/core/scalars";
import type { ReplyOf, RpcClient } from "@lucent/rpc/client";
import { RequestId, RPC_HEADERS, toClientHeader } from "@lucent/rpc/contract";
import {
    AVATAR_IMAGE_PATH,
    AVATAR_UPLOAD_PATH,
    BANNER_UPLOAD_PATH,
    COMMUNITY_EVENTS_PATH,
    LOADER_DOWNLOAD_PATH,
    RESOURCE_DOWNLOAD_PATH,
    RESOURCE_UPLOAD_PATH,
    type WebContract,
    webContract,
} from "@lucent/rpc/web";
import { getGlobalStartContext } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import type { z } from "zod";
import { REFUSALS, type RefusalCode } from "../copy/refusals.ts";
import { processEnvironment, readWebConfig } from "./config.ts";
import { connectPlatform, connectPlatformStreams, type PlatformGet } from "./connect.ts";
import { clearSessionToken, readSessionToken } from "./cookies.ts";
import { type Outcome, refuse } from "./outcome.ts";
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
    if (name === "waitlist.application.submit" || name === "invites.link.redeem")
        return BUCKETS.admission;
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
    const back = new Response(null, { status: 303, headers: { location: "/products" } });
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

// RFC 8187's filename*: what encodeURIComponent leaves alone, less the characters the header
// grammar reserves.
function attachmentFor(name: string): string {
    const encoded = encodeURIComponent(name).replace(
        /['()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

// One resource for the signed-in member, streamed from platform as it arrives. Whether they may
// have it is platform's to decide; anything but the bytes sends the browser back to the list.
export async function downloadResource(resourceId: string, signal: AbortSignal): Promise<Response> {
    const web = currentRequest();
    const back = new Response(null, { status: 303, headers: { location: "/resources" } });
    const session = readSessionToken();
    if (session === null || !/^[0-9a-f-]{36}$/.test(resourceId)) return back;
    const startedAt = systemClock.now();
    const reply = await tryAsync(
        () =>
            platformStreams()(
                `${RESOURCE_DOWNLOAD_PATH}/${resourceId}`,
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
    const name = res?.headers.get("lucent-file-name") ?? null;
    if (res?.status === 200 && res.body !== null && name !== null) {
        const length = res.headers.get("content-length");
        return new Response(res.body, {
            headers: {
                "content-type": "application/octet-stream",
                "content-disposition": attachmentFor(decodeURIComponent(name)),
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

// The member's avatar upload: half a megabyte at most, and platform's decoder answers within
// seconds, so a minute covers a slow line too.
const AVATAR_DEADLINE_MS = 60 * 1_000;
const AVATAR_MAX_BYTES = 512 * 1024;
// The answers the avatar route passes on as they are; anything else is unexpected.
const AVATAR_REFUSALS: ReadonlySet<string> = new Set<RefusalCode>([
    "SESSION_INVALID",
    "POSTING_RESTRICTED",
    "PROFILE_REMOVED",
    "IMAGE_TOO_LARGE",
    "NOT_AN_IMAGE",
    "IMAGE_UNDECODABLE",
    "IMAGE_TIMED_OUT",
    "INVALID_REQUEST",
    "THROTTLED",
]);

function isAvatarRefusal(code: unknown): code is RefusalCode {
    return typeof code === "string" && AVATAR_REFUSALS.has(code);
}

type AvatarDigests = { readonly large: string; readonly small: string };

function answerAvatar(outcome: Outcome<AvatarDigests>): Response {
    return Response.json(outcome, { headers: { "cache-control": "no-store" } });
}

function digestsOf(value: unknown): AvatarDigests | null {
    if (typeof value !== "object" || value === null) return null;
    if (!("large" in value && "small" in value)) return null;
    const { large, small } = value;
    if (typeof large !== "string" || typeof small !== "string") return null;
    return { large, small };
}

// The signed-in member's new avatar, from the browser to platform as it arrives; platform
// decides who may, bounds the bytes, decodes them in its own child process and answers the
// stored images' digests.
export async function uploadAvatar(request: Request): Promise<Response> {
    const web = currentRequest();
    const session = readSessionToken();
    if (session === null) return answerAvatar(refuse({ code: "SESSION_INVALID" }));
    const length = Number(request.headers.get("content-length") ?? "");
    if (!Number.isSafeInteger(length) || length <= 0 || request.body === null) {
        return answerAvatar(refuse({ code: "INVALID_REQUEST" }));
    }
    if (length > AVATAR_MAX_BYTES) return answerAvatar(refuse({ code: "IMAGE_TOO_LARGE" }));
    const startedAt = systemClock.now();
    const reply = await tryAsync(
        async () => {
            const res = await platformStreams()(
                AVATAR_UPLOAD_PATH,
                {
                    [RPC_HEADERS.session]: session,
                    [RPC_HEADERS.client]: toClientHeader(web.client),
                    [RPC_HEADERS.request]: web.requestId,
                    "content-length": String(length),
                },
                AbortSignal.any([request.signal, AbortSignal.timeout(AVATAR_DEADLINE_MS)]),
                request.body ?? undefined,
            );
            const parsed: unknown = await res.json();
            return { status: res.status, body: parsed };
        },
        () => null,
    );
    web.trace.addPlatformTime(systemClock.now() - startedAt);
    const body = reply.ok ? reply.value.body : null;
    if (typeof body !== "object" || body === null) {
        return answerAvatar(refuse({ code: "SERVICE_UNAVAILABLE" }));
    }
    if ("value" in body && reply.ok && reply.value.status === 200) {
        const digests = digestsOf(body.value);
        if (digests !== null) return answerAvatar({ ok: true, value: digests });
    }
    const code = "error" in body ? codeOf(body.error) : null;
    if (code === "SESSION_INVALID") clearSessionToken();
    return answerAvatar(refuse({ code: isAvatarRefusal(code) ? code : "SERVICE_UNAVAILABLE" }));
}

// The banner upload is the avatar upload's twin: the answer is one digest instead of a pair.
export async function uploadBanner(request: Request): Promise<Response> {
    const web = currentRequest();
    const session = readSessionToken();
    if (session === null) return answerAvatar(refuse({ code: "SESSION_INVALID" }));
    const length = Number(request.headers.get("content-length") ?? "");
    if (!Number.isSafeInteger(length) || length <= 0 || request.body === null) {
        return answerAvatar(refuse({ code: "INVALID_REQUEST" }));
    }
    if (length > AVATAR_MAX_BYTES) return answerAvatar(refuse({ code: "IMAGE_TOO_LARGE" }));
    const startedAt = systemClock.now();
    const reply = await tryAsync(
        async () => {
            const res = await platformStreams()(
                BANNER_UPLOAD_PATH,
                {
                    [RPC_HEADERS.session]: session,
                    [RPC_HEADERS.client]: toClientHeader(web.client),
                    [RPC_HEADERS.request]: web.requestId,
                    "content-length": String(length),
                },
                AbortSignal.any([request.signal, AbortSignal.timeout(AVATAR_DEADLINE_MS)]),
                request.body ?? undefined,
            );
            const parsed: unknown = await res.json();
            return { status: res.status, body: parsed };
        },
        () => null,
    );
    web.trace.addPlatformTime(systemClock.now() - startedAt);
    const body = reply.ok ? reply.value.body : null;
    if (typeof body !== "object" || body === null) {
        return answerAvatar(refuse({ code: "SERVICE_UNAVAILABLE" }));
    }
    if ("value" in body && reply.ok && reply.value.status === 200) {
        const value = body.value;
        if (
            typeof value === "object" &&
            value !== null &&
            "digest" in value &&
            typeof value.digest === "string"
        ) {
            return Response.json(
                { ok: true, value: { digest: value.digest } },
                { headers: { "cache-control": "no-store" } },
            );
        }
    }
    const code = "error" in body ? codeOf(body.error) : null;
    if (code === "SESSION_INVALID") clearSessionToken();
    return answerAvatar(refuse({ code: isAvatarRefusal(code) ? code : "SERVICE_UNAVAILABLE" }));
}

const AVATAR_DIGEST = /^[0-9a-f]{64}$/;
const AVATAR_READ_DEADLINE_MS = 10 * 1_000;

// One avatar image for the signed-in member, when platform says they may see it. A digest names
// its bytes for good, so the browser keeps it a year; only this browser, since whose picture a
// member may see is decided per member. Everything else is a bare 404: an image tag has no page
// to show a refusal on.
export async function serveAvatar(digest: string, signal: AbortSignal): Promise<Response> {
    const web = currentRequest();
    const missing = new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    const session = readSessionToken();
    if (session === null || !AVATAR_DIGEST.test(digest)) return missing;
    const startedAt = systemClock.now();
    const reply = await tryAsync(
        () =>
            platformStreams()(
                `${AVATAR_IMAGE_PATH}/${digest}`,
                {
                    [RPC_HEADERS.session]: session,
                    [RPC_HEADERS.client]: toClientHeader(web.client),
                    [RPC_HEADERS.request]: web.requestId,
                },
                AbortSignal.any([signal, AbortSignal.timeout(AVATAR_READ_DEADLINE_MS)]),
            ),
        () => null,
    );
    web.trace.addPlatformTime(systemClock.now() - startedAt);
    const res = reply.ok ? reply.value : null;
    if (res?.status === 200 && res.body !== null) {
        const length = res.headers.get("content-length");
        return new Response(res.body, {
            headers: {
                "content-type": "image/webp",
                "cache-control": "private, max-age=31536000, immutable",
                "x-content-type-options": "nosniff",
                ...(length === null ? {} : { "content-length": length }),
            },
        });
    }
    await res?.body?.cancel();
    return missing;
}

// The community event stream for the signed-in member, passed on as it arrives. It lives as long
// as the browser keeps it open, so the deadline is only a ceiling: EventSource reconnects by
// itself, and a reconnect re-reads the session. Signed out (or a session platform no longer
// takes) is a bare 401, which ends EventSource's retries.
const EVENTS_DEADLINE_MS = 60 * 60 * 1_000;

export async function streamCommunityEvents(signal: AbortSignal): Promise<Response> {
    const web = currentRequest();
    const refused = (status: 401 | 503) =>
        new Response(null, { status, headers: { "cache-control": "no-store" } });
    const session = readSessionToken();
    if (session === null) return refused(401);
    const reply = await tryAsync(
        () =>
            platformStreams()(
                COMMUNITY_EVENTS_PATH,
                {
                    [RPC_HEADERS.session]: session,
                    [RPC_HEADERS.client]: toClientHeader(web.client),
                    [RPC_HEADERS.request]: web.requestId,
                },
                AbortSignal.any([signal, AbortSignal.timeout(EVENTS_DEADLINE_MS)]),
            ),
        () => null,
    );
    const res = reply.ok ? reply.value : null;
    if (res?.status === 200 && res.body !== null) {
        return new Response(res.body, {
            headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-store",
                "x-accel-buffering": "no",
            },
        });
    }
    await res?.body?.cancel();
    if (res?.status === 401) {
        clearSessionToken();
        return refused(401);
    }
    return refused(503);
}

// A staff upload can take a while on a slow line; the browser leaving ends it sooner.
const UPLOAD_DEADLINE_MS = 10 * 60 * 1_000;
const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

const UPLOAD_REFUSALS: ReadonlySet<string> = new Set<RefusalCode>([
    "SESSION_INVALID",
    "FORBIDDEN",
    "STEP_UP_REQUIRED",
    "PAYLOAD_TOO_LARGE",
    "INVALID_REQUEST",
]);

function isUploadRefusal(code: unknown): code is RefusalCode {
    return typeof code === "string" && UPLOAD_REFUSALS.has(code);
}

function answer(outcome: Outcome<{ readonly digest: string; readonly size: number }>): Response {
    return Response.json(outcome, { headers: { "cache-control": "no-store" } });
}

// A resource's bytes from the browser, passed on to platform as they arrive and never held
// here; platform hashes, bounds and keeps them, and answers their digest for publishing.
export async function uploadResource(request: Request): Promise<Response> {
    const web = currentRequest();
    const session = readSessionToken();
    if (session === null) return new Response(null, { status: 404 });
    const length = Number(request.headers.get("content-length") ?? "");
    if (!Number.isSafeInteger(length) || length <= 0 || request.body === null) {
        return answer(refuse({ code: "INVALID_REQUEST" }));
    }
    if (length > UPLOAD_MAX_BYTES) return answer(refuse({ code: "PAYLOAD_TOO_LARGE" }));
    const startedAt = systemClock.now();
    const reply = await tryAsync(
        async () => {
            const res = await platformStreams()(
                RESOURCE_UPLOAD_PATH,
                {
                    [RPC_HEADERS.session]: session,
                    [RPC_HEADERS.client]: toClientHeader(web.client),
                    [RPC_HEADERS.request]: web.requestId,
                    "content-length": String(length),
                },
                AbortSignal.any([request.signal, AbortSignal.timeout(UPLOAD_DEADLINE_MS)]),
                request.body ?? undefined,
            );
            const parsed: unknown = await res.json();
            return { status: res.status, body: parsed };
        },
        () => null,
    );
    web.trace.addPlatformTime(systemClock.now() - startedAt);
    const body = reply.ok ? reply.value.body : null;
    if (typeof body !== "object" || body === null) {
        return answer(refuse({ code: "SERVICE_UNAVAILABLE" }));
    }
    if ("value" in body && reply.ok && reply.value.status === 200) {
        const stored = body.value;
        if (
            typeof stored === "object" &&
            stored !== null &&
            "digest" in stored &&
            typeof stored.digest === "string" &&
            "size" in stored &&
            typeof stored.size === "number"
        ) {
            return answer({ ok: true, value: { digest: stored.digest, size: stored.size } });
        }
    }
    const code = "error" in body ? codeOf(body.error) : null;
    // This route sits outside the admin layout, which answers a plain 404 to whoever is not
    // staff so that nothing confirms an admin area; it answers the same.
    if (code === "FORBIDDEN") return new Response(null, { status: 404 });
    if (code === "SESSION_INVALID") clearSessionToken();
    return answer(refuse({ code: isUploadRefusal(code) ? code : "SERVICE_UNAVAILABLE" }));
}
