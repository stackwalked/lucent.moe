import {
    createWriter,
    type FormatError,
    malformed,
    openReader,
    type Reader,
} from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import { ok, type Result } from "@lucent/core/result";
import { finish, readContext, writeContext } from "./codec.ts";

// The reports route (POST /v1/sessions/:id/reports): a module's health events and crash
// summaries, each batch the plaintext of a frame on the reports route's own keys and sequences,
// and the server's ack.
//
// On the wire, both version 1:
//   request: context "lucent reports v1" (32), u16 event count (1 to 64), then per event: u8 kind,
//     u32 time (monotonic milliseconds since the session opened), then by kind:
//     1 health: u16 event id, u64 subject (a fact, capability or feature key, or 0), u32 value.
//     2 crash: u32 exception code, u64 module name hash (0 means the module's own image), u32 RVA,
//       u8 frame count (0 to 16), u32 frame RVAs.
//   ack: context "lucent reports ack v1" (32), u64 the sequence it answers, u16 accepted.
// A request's plaintext is at most 16 KiB.
//
// Provenance: approved by the human on 2026-11-25 as packet 04b's layout. The golden vectors
// contracts/wire/v1/reports_* were produced by this encoder, not by native/libs/wire; native's
// encoder and decoder must match them byte for byte.
//
// Beyond the layout, this side reads an ack's accepted count as at most 64, since no batch holds
// more events than that; native's decoder applies the same bound (not yet written: it must).

const VERSION = 1;

export const MAX_REPORT_EVENTS = 64;
export const MAX_CRASH_FRAMES = 16;
export const MAX_REPORTS_PLAIN_SIZE = 16 * 1024;

const KINDS = ["health", "crash"] as const;
export type ReportKind = (typeof KINDS)[number];

export type HealthEvent = {
    readonly kind: "health";
    readonly time: number;
    readonly eventId: number;
    // A fact, capability or feature key, or 0 when the event names none.
    readonly subject: bigint;
    readonly value: number;
};

export type CrashEvent = {
    readonly kind: "crash";
    readonly time: number;
    readonly exceptionCode: number;
    // 0 for the module's own image.
    readonly moduleHash: bigint;
    readonly rva: number;
    readonly frames: readonly number[];
};

export type ReportEvent = HealthEvent | CrashEvent;

export type ReportsRequest = { readonly events: readonly ReportEvent[] };

export type ReportsAck = {
    // The sequence of the module's reports-route frame this answers.
    readonly answers: bigint;
    readonly accepted: number;
};

const isU16 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff;
const isU32 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
const isU64 = (value: bigint) => value >= 0n && value <= 0xffff_ffff_ffff_ffffn;

function isEvent(event: ReportEvent): boolean {
    if (!isU32(event.time)) {
        return false;
    }
    if (event.kind === "health") {
        return isU16(event.eventId) && isU64(event.subject) && isU32(event.value);
    }
    return (
        isU32(event.exceptionCode) &&
        isU64(event.moduleHash) &&
        isU32(event.rva) &&
        event.frames.length <= MAX_CRASH_FRAMES &&
        event.frames.every(isU32)
    );
}

export function toReportsRequestBytes(request: ReportsRequest): Uint8Array<ArrayBuffer> {
    const { events } = request;
    invariant(
        events.length >= 1 && events.length <= MAX_REPORT_EVENTS,
        "report event count out of range",
    );
    const out = createWriter();
    writeContext(out, "reports", VERSION);
    out.u16(events.length);
    for (const event of events) {
        invariant(isEvent(event), "report event isn't canonical");
        out.u8(KINDS.indexOf(event.kind) + 1);
        out.u32(event.time);
        if (event.kind === "health") {
            out.u16(event.eventId);
            out.u64(event.subject);
            out.u32(event.value);
            continue;
        }
        out.u32(event.exceptionCode);
        out.u64(event.moduleHash);
        out.u32(event.rva);
        out.u8(event.frames.length);
        for (const frame of event.frames) {
            out.u32(frame);
        }
    }
    const bytes = out.finish();
    invariant(bytes.byteLength <= MAX_REPORTS_PLAIN_SIZE, "reports request too large");
    return bytes;
}

function readEvent(input: Reader): Result<ReportEvent, FormatError> {
    if (input.remaining() < 1 + 4) {
        return malformed();
    }
    const kind = KINDS[input.u8() - 1];
    const time = input.u32();
    if (kind === "health") {
        if (input.remaining() < 2 + 8 + 4) {
            return malformed();
        }
        return ok({
            kind,
            time,
            eventId: input.u16(),
            subject: input.u64(),
            value: input.u32(),
        });
    }
    if (kind !== "crash" || input.remaining() < 4 + 8 + 4 + 1) {
        return malformed();
    }
    const exceptionCode = input.u32();
    const moduleHash = input.u64();
    const rva = input.u32();
    const count = input.u8();
    if (count > MAX_CRASH_FRAMES || input.remaining() < count * 4) {
        return malformed();
    }
    const frames: number[] = [];
    for (let index = 0; index < count; index += 1) {
        frames.push(input.u32());
    }
    return ok({ kind, time, exceptionCode, moduleHash, rva, frames });
}

// Canonical or nothing: within 16 KiB, 1 to 64 events of known kinds, 0 to 16 frames per crash,
// nothing trailing.
export function parseReportsRequest(bytes: Uint8Array): Result<ReportsRequest, FormatError> {
    if (bytes.byteLength > MAX_REPORTS_PLAIN_SIZE) {
        return malformed();
    }
    const input = openReader(bytes);
    const context = readContext(input, "reports", VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 2) {
        return malformed();
    }
    const count = input.u16();
    if (count < 1 || count > MAX_REPORT_EVENTS) {
        return malformed();
    }
    const events: ReportEvent[] = [];
    for (let index = 0; index < count; index += 1) {
        const event = readEvent(input);
        if (!event.ok) {
            return event;
        }
        events.push(event.value);
    }
    return finish(input, { events });
}

export function toReportsAckBytes(ack: ReportsAck): Uint8Array<ArrayBuffer> {
    invariant(
        Number.isInteger(ack.accepted) && ack.accepted >= 0 && ack.accepted <= MAX_REPORT_EVENTS,
        "accepted count out of range",
    );
    const out = createWriter();
    writeContext(out, "reports ack", VERSION);
    out.u64(ack.answers);
    out.u16(ack.accepted);
    return out.finish();
}

// Canonical or nothing: an accepted count of at most 64, nothing trailing.
export function parseReportsAck(bytes: Uint8Array): Result<ReportsAck, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "reports ack", VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 8 + 2) {
        return malformed();
    }
    const answers = input.u64();
    const accepted = input.u16();
    if (accepted > MAX_REPORT_EVENTS) {
        return malformed();
    }
    return finish(input, { answers, accepted });
}
