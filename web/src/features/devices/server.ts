import { OperationId } from "@lucent/core/scalars";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

const WireId = z.string().regex(/^[0-9a-f]{32}$/);
const SignInRequestId = z.string().regex(/^lauth_[A-Za-z0-9_-]{22}$/);

export const fetchDevices = createServerFn({ method: "GET" }).handler(async () => {
    const [devices, enrollments] = [
        await readPlatform("devices.list", {}),
        await readPlatform("devices.enrollments.list", {}),
    ];
    if (!devices.ok) return refuse(devices.error);
    if (!enrollments.ok) return refuse(enrollments.error);
    return done({ ...devices.value, enrollments: enrollments.value.enrollments });
});

export const approveEnrollment = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ operationId: OperationId, enrollmentId: WireId }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("devices.enrollments.approve", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const denyEnrollment = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ enrollmentId: WireId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("devices.enrollments.deny", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const renameDevice = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ deviceId: WireId, name: z.string().max(64).nullable() }).parse(data),
    )
    .handler(async ({ data }) => {
        const name = data.name?.trim() ?? "";
        const reply = await callPlatform("devices.rename", {
            deviceId: data.deviceId,
            name: name === "" ? null : name,
        });
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const removeDevice = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ operationId: OperationId, deviceId: WireId }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("devices.remove", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

// The loader's sign-in request: what it is, for the member to recognise before deciding. One
// answered, expired or never made reads the same: there's nothing left to decide.
export const fetchSignInRequest = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ requestId: SignInRequestId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("devices.signIn.read", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

// Where the browser goes next: the loader's listener on this PC, carrying the answer.
export const decideSignInRequest = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({ requestId: SignInRequestId, decision: z.enum(["approve", "deny"]) })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform(
            data.decision === "approve" ? "devices.signIn.approve" : "devices.signIn.deny",
            { requestId: data.requestId },
        );
        return reply.ok ? done(reply.value.redirectTo) : refuse(reply.error);
    });
