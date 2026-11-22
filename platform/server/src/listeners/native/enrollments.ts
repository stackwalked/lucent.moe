import { parseEnrollmentRequest, toEnrollmentStatusBytes } from "@lucent/wire/enrollment";
import type { Hono } from "hono";
import { readEnrollment, requestEnrollment } from "../../devices/devices.ts";
import { binaryResponse, operationIdOf, parseIdSegment, refusalResponse } from "./http.ts";
import { reply } from "./responses.ts";
import type { NativeRoutes } from "./route-context.ts";

export function mountEnrollments(app: Hono, { deps, authenticated, body }: NativeRoutes): void {
    app.post("/v1/enrollments", async (c) => {
        const caller = await authenticated(c, "enrollments.create");
        if (!caller.ok) return refusalResponse(caller.error);
        const operationId = operationIdOf(c.req.raw);
        const bytes = await body(c);
        if (!bytes.ok) return refusalResponse(bytes.error);
        const request = parseEnrollmentRequest(bytes.value);
        if (operationId === null || !request.ok)
            return refusalResponse({ code: "INVALID_REQUEST" });
        const status = await requestEnrollment(deps.db, {
            rng: deps.rng,
            ...caller.value,
            storage: request.value.storage,
            operationId,
        });
        return reply(status, (value) => binaryResponse(toEnrollmentStatusBytes(value)));
    });

    app.get("/v1/enrollments/:id", async (c) => {
        const caller = await authenticated(c, "enrollments.read");
        if (!caller.ok) return refusalResponse(caller.error);
        const enrollmentId = parseIdSegment(c.req.param("id"));
        if (enrollmentId === null) return refusalResponse({ code: "NOT_FOUND" });
        const status = await readEnrollment(deps.db, { ...caller.value, enrollmentId });
        return reply(status, (value) => binaryResponse(toEnrollmentStatusBytes(value)));
    });
}
