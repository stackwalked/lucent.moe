import { toHex } from "@lucent/core/scalars";
import { encryptedSize, toEncryptedContainerStream } from "@lucent/wire/container-stream";
import { parseFrame } from "@lucent/wire/frame";
import { parseLeaseRequest } from "@lucent/wire/lease-exchange";
import { parseSessionHello } from "@lucent/wire/session";
import { parseStartRequest, toStartReplyBytes } from "@lucent/wire/start";
import type { Hono } from "hono";
import { closeSession, openSession, renewLease, serveData } from "../../runtime/sessions.ts";
import { createStart, readStartContainer } from "../../runtime/starts.ts";
import {
    binaryResponse,
    MAX_DATA_BODY_BYTES,
    operationIdOf,
    parseIdSegment,
    refusalResponse,
} from "./http.ts";
import { refusalOf, reply } from "./responses.ts";
import type { NativeRoutes } from "./route-context.ts";

export function mountRuntime(
    app: Hono,
    { deps, authenticated, body, unavailable }: NativeRoutes,
): void {
    app.post("/v1/starts", async (c) => {
        const caller = await authenticated(c, "starts.create");
        if (!caller.ok) return refusalResponse(caller.error);
        const operationId = operationIdOf(c.req.raw);
        const bytes = await body(c);
        if (!bytes.ok) return refusalResponse(bytes.error);
        const request = parseStartRequest(bytes.value);
        if (operationId === null || !request.ok)
            return refusalResponse({ code: "INVALID_REQUEST" });
        const started = await createStart(deps.db, {
            rng: deps.rng,
            catalog: deps.catalog,
            ...caller.value,
            request: request.value,
            operationId,
        });
        return reply(started, (value) => binaryResponse(toStartReplyBytes(value)));
    });

    app.get("/v1/starts/:id/container", async (c) => {
        const caller = await authenticated(c, "starts.container");
        if (!caller.ok) return refusalResponse(caller.error);
        const startId = parseIdSegment(c.req.param("id"));
        if (startId === null) return refusalResponse({ code: "NOT_FOUND" });
        const found = await readStartContainer(deps.db, {
            ...caller.value,
            startId,
            catalog: deps.catalog,
        });
        return reply(
            found,
            (start) =>
                new Response(
                    toEncryptedContainerStream({
                        key: start.key,
                        container: start.container,
                        rng: deps.rng,
                    }),
                    {
                        headers: {
                            "content-type": "application/octet-stream",
                            "content-length": String(encryptedSize(start.container.byteLength)),
                            "cache-control": "no-store",
                        },
                    },
                ),
        );
    });

    app.post("/v1/starts/:id/session", async (c) => {
        const caller = await authenticated(c, "sessions.open");
        if (!caller.ok) return refusalResponse(caller.error);
        const startId = parseIdSegment(c.req.param("id"));
        if (startId === null) return refusalResponse({ code: "NOT_FOUND" });
        const operationId = operationIdOf(c.req.raw);
        const bytes = await body(c);
        if (!bytes.ok) return refusalResponse(bytes.error);
        const hello = parseSessionHello(bytes.value);
        if (operationId === null || !hello.ok) return refusalResponse({ code: "INVALID_REQUEST" });
        const opened = await openSession(deps.db, {
            rng: deps.rng,
            catalog: deps.catalog,
            signer: deps.signer,
            ...caller.value,
            startId,
            hello: hello.value,
            operationId,
        });
        if (opened.ok) return binaryResponse(opened.value);
        if (opened.error.code === "DATA_TOO_LARGE") {
            return await unavailable(
                `first data response of ${opened.error.size} bytes for start ${toHex(startId)}`,
                "data_response_too_large",
            );
        }
        return refusalResponse(refusalOf(opened.error));
    });

    app.post("/v1/sessions/:id/lease", async (c) => {
        const caller = await authenticated(c, "sessions.lease");
        if (!caller.ok) return refusalResponse(caller.error);
        const sessionId = parseIdSegment(c.req.param("id"));
        if (sessionId === null) return refusalResponse({ code: "NOT_FOUND" });
        const operationId = operationIdOf(c.req.raw);
        const bytes = await body(c);
        if (!bytes.ok) return refusalResponse(bytes.error);
        const request = parseLeaseRequest(bytes.value);
        if (operationId === null || !request.ok)
            return refusalResponse({ code: "INVALID_REQUEST" });
        const renewed = await renewLease(deps.db, {
            rng: deps.rng,
            signer: deps.signer,
            ...caller.value,
            sessionId,
            request: request.value,
            body: bytes.value,
            operationId,
        });
        return reply(renewed, (bytesOut) => binaryResponse(bytesOut));
    });

    app.post("/v1/sessions/:id/data", async (c) => {
        const caller = await authenticated(c, "sessions.data");
        if (!caller.ok) return refusalResponse(caller.error);
        const sessionId = parseIdSegment(c.req.param("id"));
        if (sessionId === null) return refusalResponse({ code: "NOT_FOUND" });
        const operationId = operationIdOf(c.req.raw);
        const bytes = await body(c, MAX_DATA_BODY_BYTES);
        if (!bytes.ok) return refusalResponse(bytes.error);
        const frame = parseFrame(bytes.value);
        if (operationId === null || !frame.ok) return refusalResponse({ code: "INVALID_REQUEST" });
        const served = await serveData(deps.db, {
            rng: deps.rng,
            cloudLimits: deps.cloudLimits ?? null,
            ...caller.value,
            sessionId,
            frame: frame.value,
            body: bytes.value,
            operationId,
        });
        if (served.ok) return binaryResponse(served.value);
        if (served.error.code === "DATA_TOO_LARGE") {
            return await unavailable(
                `data response of ${served.error.size} bytes for session ${toHex(sessionId)}`,
                "data_response_too_large",
            );
        }
        return refusalResponse(refusalOf(served.error));
    });

    app.post("/v1/sessions/:id/close", async (c) => {
        const caller = await authenticated(c, "sessions.close");
        if (!caller.ok) return refusalResponse(caller.error);
        const sessionId = parseIdSegment(c.req.param("id"));
        if (sessionId === null) return refusalResponse({ code: "NOT_FOUND" });
        const closed = await closeSession(deps.db, { ...caller.value, sessionId });
        return reply(closed, () => new Response(null, { status: 204 }));
    });
}
