import { type Clock, systemClock } from "@lucent/core/clock";
import { err, ok } from "@lucent/core/result";
import { BearerToken } from "@lucent/core/scalars";
import { RPC_HEADERS } from "@lucent/rpc/contract";
import { AVATAR_IMAGE_PATH, AVATAR_UPLOAD_PATH } from "@lucent/rpc/web";
import { AvatarDigest } from "@lucent/rpc/web/community";
import type { Hono } from "hono";
import { AVATAR_MAX_BYTES, transcodeAvatar } from "../../adapters/image/image.ts";
import { checkAvatarUpload, readAvatarImage, setAvatar } from "../../community/avatars.ts";
import type { Logger } from "../../core/log.ts";
import type { Db } from "../../db/pool.ts";
import { createRateLimiter, type RateRule } from "../native/rate-limit.ts";

type Status = 400 | 401 | 403 | 404 | 413 | 422 | 429 | 503;

const UPLOAD_ROUTE = "avatars.upload";
// Per account, per minute: a member trying a few pictures in a row, not a decoder farm.
const UPLOAD_RATE: Readonly<Record<string, RateRule>> = { [UPLOAD_ROUTE]: { perMinute: 6 } };

function refusal(error: { readonly code: string }, status: Status): Response {
    return Response.json(err(error), { status, headers: { "cache-control": "no-store" } });
}

// The body up to `limit` bytes, or null once it goes past: a lying Content-Length gets no further
// than an honest one.
async function readBounded(body: ReadableStream<Uint8Array>, limit: number) {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const part of body) {
        total += part.length;
        if (total > limit) return null;
        parts.push(part);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

// A refusal from the session, the member's standing or the profile, as any of these routes
// answers it.
function writeRefusal(error: { readonly code: string }): Response {
    if (error.code === "SESSION_INVALID") return refusal(error, 401);
    if (error.code === "POSTING_RESTRICTED" || error.code === "PROFILE_REMOVED") {
        return refusal(error, 403);
    }
    return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
}

// The internal listener's streaming routes for avatars, behind the mount's peer-key check.
//
// Upload: a POST of the raw image with the member's `Lucent-Session` and a Content-Length of at
// most 512 KiB. Who may set an avatar is decided before a byte is read, and again under the
// writer's locks after the decoder child has answered; the child runs with no transaction open.
// Images: a GET of `<path>/<digest>`, answered with the WebP while some profile the member may
// open names it. A digest names its bytes forever, so the answer is cached for a year; it is
// `private`, because who may see a picture is decided per member and the route sits behind a
// session.
export function mountAvatars(
    app: Hono,
    deps: {
        readonly db: Db;
        readonly isSuperseded: () => boolean;
        readonly logger: Logger;
        // Upload rate limits only; who may upload is decided on the database's clock.
        readonly clock?: Clock;
    },
): void {
    const limiter = createRateLimiter({ clock: deps.clock ?? systemClock, rules: UPLOAD_RATE });

    app.post(AVATAR_UPLOAD_PATH, async (c) => {
        if (deps.isSuperseded()) return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        const token = BearerToken.safeParse(c.req.header(RPC_HEADERS.session));
        if (!token.success) return refusal({ code: "INVALID_REQUEST" }, 400);
        const length = Number(c.req.header("content-length") ?? "");
        if (!Number.isSafeInteger(length) || length <= 0) {
            return refusal({ code: "INVALID_REQUEST" }, 400);
        }
        if (length > AVATAR_MAX_BYTES) return refusal({ code: "IMAGE_TOO_LARGE" }, 413);
        const allowed = await checkAvatarUpload(deps.db, token.data);
        if (!allowed.ok) return writeRefusal(allowed.error);
        // Counted only for uploads the member may make, and before a byte of the body is read.
        if (!limiter.take(UPLOAD_ROUTE, allowed.value.accountId).ok) {
            return refusal({ code: "THROTTLED" }, 429);
        }
        const body = c.req.raw.body;
        if (body === null) return refusal({ code: "INVALID_REQUEST" }, 400);
        const bytes = await readBounded(body, AVATAR_MAX_BYTES);
        if (bytes === null) return refusal({ code: "IMAGE_TOO_LARGE" }, 413);

        const images = await transcodeAvatar(bytes);
        if (!images.ok) {
            const { error } = images;
            if (error.code === "IMAGE_BUSY") {
                deps.logger.write("warn", "avatar_decoders_busy", { origin: "internal-web" });
                return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
            }
            if (error.code === "IMAGE_CHILD_FAILED" || error.code === "IMAGE_CODEC_FAILED") {
                deps.logger.write("error", "avatar_decoder_failed", {
                    origin: "internal-web",
                    detail: `${error.code}: ${error.detail}`,
                });
                return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
            }
            return refusal(error, error.code === "IMAGE_TOO_LARGE" ? 413 : 422);
        }
        const saved = await setAvatar(deps.db, token.data, images.value);
        if (!saved.ok) return writeRefusal(saved.error);
        return Response.json(ok(saved.value), { headers: { "cache-control": "no-store" } });
    });

    app.get(`${AVATAR_IMAGE_PATH}/:digest`, async (c) => {
        if (deps.isSuperseded()) return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        const token = BearerToken.safeParse(c.req.header(RPC_HEADERS.session));
        const digest = AvatarDigest.safeParse(c.req.param("digest"));
        if (!token.success || !digest.success) return refusal({ code: "INVALID_REQUEST" }, 400);
        const image = await readAvatarImage(deps.db, token.data, { digest: digest.data });
        if (!image.ok) {
            if (image.error.code === "SESSION_INVALID") return refusal(image.error, 401);
            if (image.error.code === "NOT_FOUND") return refusal(image.error, 404);
            return refusal({ code: "SERVICE_UNAVAILABLE" }, 503);
        }
        return new Response(image.value, {
            headers: {
                "content-type": "image/webp",
                "content-length": String(image.value.length),
                "cache-control": "private, max-age=31536000, immutable",
                "x-content-type-options": "nosniff",
            },
        });
    });
}
