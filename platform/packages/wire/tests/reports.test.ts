import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWriter } from "@lucent/bundle/wire";
import { z } from "zod";
import {
    MAX_CRASH_FRAMES,
    MAX_REPORT_EVENTS,
    MAX_REPORTS_PLAIN_SIZE,
    parseReportsAck,
    parseReportsRequest,
    type ReportEvent,
    toReportsAckBytes,
    toReportsRequestBytes,
} from "../src/reports.ts";
import { toVectorJson } from "./cloud-vectors.ts";
import { hexU32, hexU64, readContractFile, readContractJson } from "./fixtures.ts";
import { reportsVectors } from "./reports-vectors.ts";

const contractPath = (file: string) =>
    join(import.meta.dir, "..", "..", "..", "..", "contracts", "wire", "v1", file);

// contracts/wire/v1/reports_*, produced by src/reports.ts's encoder through reports-vectors.ts;
// native/libs/wire must match them. The refusals below build or patch bytes at offsets written
// out here, so they state the layout independently of the encoder.

const MALFORMED = { ok: false, error: { code: "MALFORMED" } } as const;
const MISMATCH = { ok: false, error: { code: "VERSION_MISMATCH" } } as const;

const RequestVector = z.strictObject({
    events: z.array(
        z.union([
            z
                .strictObject({
                    kind: z.literal("health"),
                    time: z.number().int(),
                    event_id: z.number().int(),
                    subject: hexU64,
                    value: z.number().int(),
                })
                .transform(
                    ({ time, event_id, subject, value }): ReportEvent => ({
                        kind: "health",
                        time,
                        eventId: event_id,
                        subject,
                        value,
                    }),
                ),
            z
                .strictObject({
                    kind: z.literal("crash"),
                    time: z.number().int(),
                    exception_code: hexU32,
                    module_hash: hexU64,
                    rva: hexU32,
                    frames: z.array(hexU32),
                })
                .transform(
                    ({ time, exception_code, module_hash, rva, frames }): ReportEvent => ({
                        kind: "crash",
                        time,
                        exceptionCode: exception_code,
                        moduleHash: module_hash,
                        rva,
                        frames,
                    }),
                ),
        ]),
    ),
});

const AckVector = z.strictObject({ answers: hexU64, accepted: z.number().int() });

async function bytesOf(name: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await readContractFile("wire", `${name}.bin`));
}

function withByte(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const out = bytes.slice();
    out[offset] = value;
    return out;
}

function context(text: string): Uint8Array {
    const out = new Uint8Array(32);
    out.set(new TextEncoder().encode(text));
    return out;
}

// A request by hand: the context, a count, then `fill` writes the events.
function request(count: number, fill: (out: ReturnType<typeof createWriter>) => void) {
    const out = createWriter();
    out.bytes(context("lucent reports v1"));
    out.u16(count);
    fill(out);
    return out.finish();
}

function health(out: ReturnType<typeof createWriter>, kind = 1) {
    out.u8(kind);
    out.u32(10);
    out.u16(1);
    out.u64(0n);
    out.u32(2);
}

function crashWithFrames(frames: number) {
    return request(1, (out) => {
        out.u8(2);
        out.u32(10);
        out.u32(0xc000_0005);
        out.u64(0n);
        out.u32(0x100);
        out.u8(frames);
        for (let index = 0; index < frames; index += 1) {
            out.u32(index);
        }
    });
}

test("the committed reports vectors are what reports-vectors.ts makes", async () => {
    const made = reportsVectors();

    expect(Object.keys(made).sort()).toEqual(["reports_ack", "reports_request"]);
    for (const [name, vector] of Object.entries(made)) {
        expect(await bytesOf(name)).toEqual(new Uint8Array(vector.bytes));
        expect(await Bun.file(contractPath(`${name}.json`)).text()).toBe(toVectorJson(vector.json));
    }
});

test("the reports vectors decode to what they state, and encode back to their bytes", async () => {
    const requestBytes = await bytesOf("reports_request");
    const stated = RequestVector.parse(await readContractJson("wire", "reports_request.json"));
    const ackBytes = await bytesOf("reports_ack");
    const ack = AckVector.parse(await readContractJson("wire", "reports_ack.json"));

    expect(parseReportsRequest(requestBytes)).toEqual({ ok: true, value: stated });
    expect(toReportsRequestBytes(stated)).toEqual(requestBytes);
    expect(parseReportsAck(ackBytes)).toEqual({ ok: true, value: ack });
    expect(toReportsAckBytes(ack)).toEqual(ackBytes);
});

test("no prefix or extension of a reports vector decodes", async () => {
    for (const [name, parse] of [
        ["reports_request", parseReportsRequest],
        ["reports_ack", parseReportsAck],
    ] as const) {
        const bytes = await bytesOf(name);
        const extended = new Uint8Array(bytes.byteLength + 1);
        extended.set(bytes);

        expect(parse(bytes).ok).toBe(true);
        for (let size = 0; size < bytes.byteLength; size += 1) {
            expect(parse(bytes.subarray(0, size))).toEqual(MALFORMED);
        }
        expect(parse(extended)).toEqual(MALFORMED);
    }
});

test("a reports message under another kind's context is malformed, its own at v2 a version mismatch", async () => {
    const requestBytes = await bytesOf("reports_request");
    const ackBytes = await bytesOf("reports_ack");

    expect(parseReportsAck(requestBytes)).toEqual(MALFORMED);
    expect(parseReportsRequest(ackBytes)).toEqual(MALFORMED);
    // "lucent reports v1": the version digit at 16; "lucent reports ack v1": at 20.
    expect(parseReportsRequest(withByte(requestBytes, 16, "2".charCodeAt(0)))).toEqual(MISMATCH);
    expect(parseReportsAck(withByte(ackBytes, 20, "2".charCodeAt(0)))).toEqual(MISMATCH);
    const asCloud = requestBytes.slice();
    asCloud.set(context("lucent cloud request v1"));
    expect(parseReportsRequest(asCloud)).toEqual(MALFORMED);
});

test("a batch holds 1 to 64 events, and its count is the events that follow", async () => {
    const events = (count: number) =>
        request(count, (out) => {
            for (let index = 0; index < count; index += 1) health(out);
        });
    const bytes = await bytesOf("reports_request");

    expect(parseReportsRequest(events(0))).toEqual(MALFORMED);
    expect(parseReportsRequest(events(1)).ok).toBe(true);
    expect(parseReportsRequest(events(MAX_REPORT_EVENTS)).ok).toBe(true);
    expect(parseReportsRequest(events(MAX_REPORT_EVENTS + 1))).toEqual(MALFORMED);
    // The vector's four events under a count of three leave one trailing; of five, one missing.
    expect(parseReportsRequest(withByte(bytes, 32, 3))).toEqual(MALFORMED);
    expect(parseReportsRequest(withByte(bytes, 32, 5))).toEqual(MALFORMED);
});

test("an event of an unknown kind is malformed", async () => {
    const bytes = await bytesOf("reports_request");

    // The first event's kind is at 34.
    for (const kind of [0, 3, 0xff]) {
        expect(parseReportsRequest(withByte(bytes, 34, kind))).toEqual(MALFORMED);
        expect(parseReportsRequest(request(1, (out) => health(out, kind)))).toEqual(MALFORMED);
    }
});

test("a crash carries 0 to 16 frames, as many as its count says", async () => {
    const bytes = await bytesOf("reports_request");

    expect(parseReportsRequest(crashWithFrames(0)).ok).toBe(true);
    expect(parseReportsRequest(crashWithFrames(MAX_CRASH_FRAMES)).ok).toBe(true);
    expect(parseReportsRequest(crashWithFrames(MAX_CRASH_FRAMES + 1))).toEqual(MALFORMED);
    // The second event (a crash at 53) counts its three frames at 74.
    expect(parseReportsRequest(withByte(bytes, 74, 2))).toEqual(MALFORMED);
    expect(parseReportsRequest(withByte(bytes, 74, 4))).toEqual(MALFORMED);
});

test("the largest batch fits the 16 KiB a request may hold", () => {
    const crash: ReportEvent = {
        kind: "crash",
        time: 0xffff_ffff,
        exceptionCode: 0xffff_ffff,
        moduleHash: 0xffff_ffff_ffff_ffffn,
        rva: 0xffff_ffff,
        frames: Array.from({ length: MAX_CRASH_FRAMES }, () => 0xffff_ffff),
    };
    const largest = toReportsRequestBytes({ events: Array(MAX_REPORT_EVENTS).fill(crash) });

    expect(largest.byteLength).toBeLessThanOrEqual(MAX_REPORTS_PLAIN_SIZE);
    expect(parseReportsRequest(largest).ok).toBe(true);
    const oversized = new Uint8Array(MAX_REPORTS_PLAIN_SIZE + 1);
    oversized.set(largest);
    expect(parseReportsRequest(oversized)).toEqual(MALFORMED);
});

test("an ack accepts at most 64 events", async () => {
    const ack = await bytesOf("reports_ack");

    // accepted, a u16, at 40.
    expect(parseReportsAck(withByte(ack, 40, MAX_REPORT_EVENTS))).toEqual({
        ok: true,
        value: { answers: 0x1_0000_0005n, accepted: MAX_REPORT_EVENTS },
    });
    expect(parseReportsAck(withByte(ack, 40, MAX_REPORT_EVENTS + 1))).toEqual(MALFORMED);
    expect(parseReportsAck(withByte(ack, 41, 1))).toEqual(MALFORMED);
});
