import { join } from "node:path";
import { type ReportEvent, toReportsAckBytes, toReportsRequestBytes } from "../src/reports.ts";
import { toVectorJson } from "./cloud-vectors.ts";

// What contracts/wire/v1/reports_* hold, made by this side's encoder: native has no generator for
// them. `bun tests/reports-vectors.ts` writes them; reports.test.ts checks the committed files
// equal what this makes.

export type ReportsVector = { readonly bytes: Uint8Array; readonly json: unknown };

const hex64 = (value: bigint) => value.toString(16).padStart(16, "0");
const hex32 = (value: number) => value.toString(16).padStart(8, "0");

// Both kinds, a crash in the module's own image and one in another module with no frames, and
// each field at a value whose bytes differ, so a decoder reading one field's width wrong fails.
const EVENTS: readonly ReportEvent[] = [
    { kind: "health", time: 1_500, eventId: 3, subject: 0x2222n, value: 7 },
    {
        kind: "crash",
        time: 61_000,
        exceptionCode: 0xc000_0005,
        moduleHash: 0n,
        rva: 0x0001_a2b0,
        frames: [0x0001_a2b0, 0x0001_c004, 0x0000_9f10],
    },
    {
        kind: "crash",
        time: 0xffff_fff0,
        exceptionCode: 0x8000_0003,
        moduleHash: 0x8000_0000_0000_0001n,
        rva: 0x0000_0400,
        frames: [],
    },
    { kind: "health", time: 0xffff_fff1, eventId: 0xffff, subject: 0n, value: 0xffff_ffff },
];

function eventJson(event: ReportEvent): unknown {
    if (event.kind === "health") {
        return {
            kind: "health",
            time: event.time,
            event_id: event.eventId,
            subject: hex64(event.subject),
            value: event.value,
        };
    }
    return {
        kind: "crash",
        time: event.time,
        exception_code: hex32(event.exceptionCode),
        module_hash: hex64(event.moduleHash),
        rva: hex32(event.rva),
        frames: event.frames.map(hex32),
    };
}

export function reportsVectors(): Readonly<Record<string, ReportsVector>> {
    return {
        reports_request: {
            bytes: toReportsRequestBytes({ events: EVENTS }),
            json: { events: EVENTS.map(eventJson) },
        },
        reports_ack: {
            bytes: toReportsAckBytes({ answers: 0x1_0000_0005n, accepted: EVENTS.length }),
            json: { answers: hex64(0x1_0000_0005n), accepted: EVENTS.length },
        },
    };
}

if (import.meta.main) {
    const out = join(import.meta.dir, "..", "..", "..", "..", "contracts", "wire", "v1");
    for (const [name, vector] of Object.entries(reportsVectors())) {
        await Bun.write(join(out, `${name}.bin`), vector.bytes);
        await Bun.write(join(out, `${name}.json`), toVectorJson(vector.json));
    }
}
