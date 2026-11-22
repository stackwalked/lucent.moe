import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import {
    approveEnrollment,
    denyEnrollment,
    listDevices,
    listPendingEnrollments,
    removeDevice,
    renameDevice,
} from "../../devices/devices.ts";
import { answerSignInRequest, readSignInRequest, SignInRequestId } from "../../devices/sign-in.ts";
import { done, mapOk, served, type WebRpcContext } from "./web-shared.ts";

export const devicesHandlers = {
    "devices.signIn.read": async (ctx, input, { session }) =>
        served(
            await readSignInRequest(ctx.auth.db, {
                sessionToken: session,
                requestId: SignInRequestId.parse(input.requestId),
            }),
        ),
    "devices.signIn.approve": async (ctx, input, { session }) =>
        served(
            await answerSignInRequest(ctx.auth.db, {
                rng: ctx.auth.rng,
                sessionToken: session,
                requestId: SignInRequestId.parse(input.requestId),
                decision: "approve",
            }),
        ),
    "devices.signIn.deny": async (ctx, input, { session }) =>
        served(
            await answerSignInRequest(ctx.auth.db, {
                rng: ctx.auth.rng,
                sessionToken: session,
                requestId: SignInRequestId.parse(input.requestId),
                decision: "deny",
            }),
        ),
    "devices.enrollments.list": async (ctx, _input, { session }) =>
        served(
            mapOk(
                await listPendingEnrollments(ctx.auth.db, { sessionToken: session }),
                (enrollments) => ({
                    enrollments,
                }),
            ),
        ),
    "devices.enrollments.approve": async (ctx, input, { session }) =>
        served(
            await approveEnrollment(ctx.auth.db, {
                rng: ctx.auth.rng,
                sessionToken: session,
                operationId: input.operationId,
                enrollmentId: Uint8Array.fromHex(input.enrollmentId),
            }),
        ),
    "devices.enrollments.deny": async (ctx, input, { session }) =>
        served(
            done(
                await denyEnrollment(ctx.auth.db, {
                    sessionToken: session,
                    enrollmentId: Uint8Array.fromHex(input.enrollmentId),
                }),
            ),
        ),
    "devices.list": async (ctx, _input, { session }) =>
        served(await listDevices(ctx.auth.db, { sessionToken: session })),
    "devices.rename": async (ctx, input, { session }) =>
        served(
            done(
                await renameDevice(ctx.auth.db, {
                    sessionToken: session,
                    deviceId: Uint8Array.fromHex(input.deviceId),
                    name: input.name,
                }),
            ),
        ),
    "devices.remove": async (ctx, input, { session }) =>
        served(
            done(
                await removeDevice(ctx.auth.db, {
                    sessionToken: session,
                    operationId: input.operationId,
                    deviceId: Uint8Array.fromHex(input.deviceId),
                }),
            ),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
