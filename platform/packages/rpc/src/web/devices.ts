import { EpochMs, OperationId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import {
    Device,
    DeviceWindow,
    Done,
    KeyStorage,
    MatchCode,
    Reused,
    refusal,
    SessionRefusal,
    SessionRefusals,
    Unavailable,
    WireId,
} from "./shared.ts";

const SignInRequestId = z.string().regex(/^lauth_[A-Za-z0-9_-]{22}$/);

const LoopbackRedirect = z.object({ redirectTo: z.string().startsWith("http://127.0.0.1:") });

const DeviceRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("NOT_FOUND"),
]);

const DeviceName = z.string().trim().min(1).max(64);

export const devicesContract = defineContract({
    // The browser half of the loader's sign-in: web shows the code the loader shows, and on
    // approval or denial sends the browser to `redirectTo`, the loader's loopback listener.
    "devices.signIn.read": {
        session: "member",
        effect: "read",
        input: z.strictObject({ requestId: SignInRequestId }),
        output: z.object({
            requestId: z.string(),
            matchCode: MatchCode,
            createdAt: EpochMs,
            expiresAt: EpochMs,
        }),
        error: DeviceRefusal,
    },
    "devices.signIn.approve": {
        session: "member",
        effect: "write",
        input: z.strictObject({ requestId: SignInRequestId }),
        output: LoopbackRedirect,
        error: DeviceRefusal,
    },
    "devices.signIn.deny": {
        session: "member",
        effect: "write",
        input: z.strictObject({ requestId: SignInRequestId }),
        output: LoopbackRedirect,
        error: DeviceRefusal,
    },
    // PCs waiting for the member to confirm them, each with the code its loader shows.
    "devices.enrollments.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            enrollments: z
                .array(
                    z.object({
                        enrollmentId: WireId,
                        matchCode: MatchCode,
                        storage: KeyStorage,
                        createdAt: EpochMs,
                        expiresAt: EpochMs,
                    }),
                )
                .readonly(),
        }),
        error: SessionRefusal,
    },
    // Needs a factor proven in the last few minutes. At the device limit the new PC replaces the
    // old one when the self-service window allows; FORBIDDEN when it no longer does, or the key
    // was enrolled elsewhere since the loader asked (the loader's own request names those first).
    "devices.enrollments.approve": {
        session: "member",
        effect: "write",
        input: z.strictObject({ operationId: OperationId, enrollmentId: WireId }),
        output: z.object({ deviceId: WireId, replaced: z.boolean() }),
        error: z.discriminatedUnion("code", [
            Unavailable,
            ...SessionRefusals,
            refusal("NOT_FOUND"),
            refusal("FORBIDDEN"),
            Reused,
        ]),
    },
    "devices.enrollments.deny": {
        session: "member",
        effect: "write",
        input: z.strictObject({ enrollmentId: WireId }),
        output: Done,
        error: DeviceRefusal,
    },
    // The member's live PCs, and when they may next replace one themselves (null: now).
    "devices.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        // `limit`: how many live PCs the account holds before approving another replaces one.
        output: z.object({
            devices: z.array(Device).readonly(),
            limit: z.number().int().positive(),
            replaceableFrom: DeviceWindow,
        }),
        error: SessionRefusal,
    },
    // Null clears the name.
    "devices.rename": {
        session: "member",
        effect: "write",
        input: z.strictObject({ deviceId: WireId, name: DeviceName.nullable() }),
        output: Done,
        error: DeviceRefusal,
    },
    // Needs a factor proven in the last few minutes, like approving one. Removing is a
    // self-service change like replacing: refused while the window is closed, and it starts the
    // window, or removing and enrolling would replace a PC as often as anyone liked.
    "devices.remove": {
        session: "member",
        effect: "write",
        input: z.strictObject({ operationId: OperationId, deviceId: WireId }),
        output: Done,
        error: z.discriminatedUnion("code", [
            Unavailable,
            ...SessionRefusals,
            refusal("NOT_FOUND"),
            refusal("DEVICE_CHANGE_TOO_SOON"),
            Reused,
        ]),
    },
});
