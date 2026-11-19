import { createWriter, type FormatError, malformed, openReader } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import type { Result } from "@lucent/core/result";
import { finish, ID_SIZE, readContext, writeContext } from "./codec.ts";

// POST /v1/enrollments and the loader's polls of it, as native/libs/wire/src/enrollment.cpp reads
// and writes them. The candidate device key is the DPoP key: its proof and public key travel in
// the DPoP header, not here.
//
// Version 1 on the wire:
//   request: context "lucent enrollment request v1" (32), u8 key storage.
//   status: context "lucent enrollment status v1" (32), enrollment id (16), u8 state, and the
//     device id (16) after approved only.

const REQUEST_VERSION = 1;
const STATUS_VERSION = 1;

export type KeyStorage = "tpm" | "software";

const STORAGES: readonly KeyStorage[] = ["tpm", "software"];

export type EnrollmentRequest = { readonly storage: KeyStorage };

export type EnrollmentStatus =
    | { readonly enrollment: Uint8Array; readonly state: "pending" | "denied" | "expired" }
    | { readonly enrollment: Uint8Array; readonly state: "approved"; readonly device: Uint8Array };

const STATES: readonly EnrollmentStatus["state"][] = ["pending", "approved", "denied", "expired"];

export function toEnrollmentRequestBytes(request: EnrollmentRequest): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    writeContext(out, "enrollment request", REQUEST_VERSION);
    out.u8(STORAGES.indexOf(request.storage));
    return out.finish();
}

export function parseEnrollmentRequest(bytes: Uint8Array): Result<EnrollmentRequest, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "enrollment request", REQUEST_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 1) {
        return malformed();
    }
    const storage = STORAGES[input.u8()];
    if (storage === undefined) {
        return malformed();
    }
    return finish(input, { storage });
}

export function toEnrollmentStatusBytes(status: EnrollmentStatus): Uint8Array<ArrayBuffer> {
    invariant(status.enrollment.byteLength === ID_SIZE, "enrollment id size");
    const out = createWriter();
    writeContext(out, "enrollment status", STATUS_VERSION);
    out.bytes(status.enrollment);
    out.u8(STATES.indexOf(status.state));
    if (status.state === "approved") {
        invariant(status.device.byteLength === ID_SIZE, "device id size");
        out.bytes(status.device);
    }
    return out.finish();
}

// Canonical or nothing: a known state, a device id after approved and nowhere else.
export function parseEnrollmentStatus(bytes: Uint8Array): Result<EnrollmentStatus, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "enrollment status", STATUS_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < ID_SIZE + 1) {
        return malformed();
    }
    const enrollment = input.bytes(ID_SIZE);
    const state = STATES[input.u8()];
    if (state === undefined) {
        return malformed();
    }
    if (state !== "approved") {
        return finish(input, { enrollment, state });
    }
    if (input.remaining() < ID_SIZE) {
        return malformed();
    }
    return finish(input, { enrollment, state, device: input.bytes(ID_SIZE) });
}
