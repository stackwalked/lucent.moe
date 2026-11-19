import { expect, test } from "bun:test";
import type { FormatError } from "@lucent/bundle/wire";
import type { Result } from "@lucent/core/result";
import { parseEnrollmentRequest, parseEnrollmentStatus } from "../src/enrollment.ts";
import { parseFrame } from "../src/frame.ts";
import { parseLease, parseLeaseRenewal } from "../src/lease.ts";
import { parseLeaseRequest, parseLeaseResponse } from "../src/lease-exchange.ts";
import { parseRefusal } from "../src/refusal.ts";
import { parseSessionHello, parseSessionReply } from "../src/session.ts";
import { sharedSecret } from "../src/session-crypto.ts";
import { parseStartReply, parseStartRequest } from "../src/start.ts";
import { readContractFile } from "./fixtures.ts";

// The refusals change the golden vectors' bytes at offsets written out here, so they state the
// layout independently of the encoders, as native/libs/wire/tests/wire_test.cpp does.

const MALFORMED = { ok: false, error: { code: "MALFORMED" } } as const;

async function bytesOf(name: string): Promise<Uint8Array> {
    return new Uint8Array(await readContractFile("wire", `${name}.bin`));
}

function withByte(bytes: Uint8Array, offset: number, value: number): Uint8Array {
    const out = bytes.slice();
    out[offset] = value;
    return out;
}

function withBytes(bytes: Uint8Array, offset: number, value: Uint8Array): Uint8Array {
    const out = bytes.slice();
    out.set(value, offset);
    return out;
}

function u64(value: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    return out;
}

type Parser = (bytes: Uint8Array) => Result<unknown, FormatError>;

const DELIMITED: readonly [string, Parser][] = [
    ["session_hello", parseSessionHello],
    ["lease_everything", parseLease],
    ["start_request", parseStartRequest],
    ["start_reply", parseStartReply],
    ["enrollment_request", parseEnrollmentRequest],
    ["enrollment_pending", parseEnrollmentStatus],
    ["enrollment_approved", parseEnrollmentStatus],
    ["refusal_slot_taken", parseRefusal],
    ["refusal_rate_limited", parseRefusal],
];

test("no prefix or extension of a self-delimiting vector decodes", async () => {
    for (const [name, parse] of DELIMITED) {
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

test("a message under another kind's context is malformed, its own at v2 a version mismatch", async () => {
    const lease = await bytesOf("lease_everything");
    const hello = await bytesOf("session_hello");

    expect(parseLeaseRenewal(lease)).toEqual(MALFORMED);
    expect(parseLease(hello)).toEqual(MALFORMED);
    expect(parseLease(withByte(lease, 14, "2".charCodeAt(0)))).toEqual({
        ok: false,
        error: { code: "VERSION_MISMATCH" },
    });
});

test("a session hello with an unknown image kind or a non-canonical X25519 key is malformed", async () => {
    const hello = await bytesOf("session_hello");
    const prime = new Uint8Array(32).fill(0xff);
    prime[0] = 0xed;
    prime[31] = 0x7f;

    expect(parseSessionHello(withByte(hello, 100, 2))).toEqual(MALFORMED);
    expect(parseSessionHello(withBytes(hello, 32, prime))).toEqual(MALFORMED);
    expect(parseSessionHello(withBytes(hello, 32, new Uint8Array(32).fill(0xff)))).toEqual(
        MALFORMED,
    );
});

test("a frame with an unknown direction or no room for a tag is malformed", async () => {
    const frame = await bytesOf("renewal_frame");

    expect(parseFrame(withByte(frame, 48, 0))).toEqual(MALFORMED);
    expect(parseFrame(withByte(frame, 48, 3))).toEqual(MALFORMED);
    expect(parseFrame(frame.subarray(0, 81 + 15))).toEqual(MALFORMED);
});

test("a session reply whose frame runs the wrong way or names another session is malformed", async () => {
    const reply = await bytesOf("session_reply");

    expect(parseSessionReply(withByte(reply, 240, 1))).toEqual(MALFORMED);
    expect(parseSessionReply(withByte(reply, 224, 0x12))).toEqual(MALFORMED);
});

test("a lease with a zero duration or challenge, a bad product, or features under everything is malformed", async () => {
    const lease = await bytesOf("lease_everything");
    const zero = new Uint8Array(4);

    expect(parseLease(withBytes(lease, 104, zero))).toEqual(MALFORMED);
    expect(parseLease(withBytes(lease, 136, zero))).toEqual(MALFORMED);
    expect(parseLease(withByte(lease, 141, "C".charCodeAt(0)))).toEqual(MALFORMED);
    expect(parseLease(withByte(lease, 144, 2))).toEqual(MALFORMED);
    // Everything, with one feature: the count at 145 says 1 and a feature takes the signature's
    // first eight bytes, so the signature runs short.
    expect(parseLease(withByte(lease, 145, 1))).toEqual(MALFORMED);
});

test("a lease's features must be sorted, unique and non-zero", async () => {
    // A listed lease built from the everything vector: flag 0, count 2, then the features.
    const lease = await bytesOf("lease_everything");
    const listed = (first: bigint, second: bigint) => {
        const out = new Uint8Array(lease.byteLength + 16);
        out.set(lease.subarray(0, 147));
        out[144] = 0;
        out[145] = 2;
        out.set(u64(first), 147);
        out.set(u64(second), 155);
        out.set(lease.subarray(147), 163);
        return out;
    };

    expect(parseLease(listed(1n, 2n)).ok).toBe(true);
    expect(parseLease(listed(2n, 1n))).toEqual(MALFORMED);
    expect(parseLease(listed(1n, 1n))).toEqual(MALFORMED);
    expect(parseLease(listed(0n, 1n))).toEqual(MALFORMED);
});

test("a start request with an unknown channel or unsorted modules is malformed", async () => {
    const request = await bytesOf("start_request");

    expect(parseStartRequest(withByte(request, 32, 3))).toEqual(MALFORMED);
    expect(parseStartRequest(withBytes(request, 70, request.slice(54, 70)))).toEqual(MALFORMED);
});

test("an enrollment status in an unknown state, or a refusal with code 0 or a bad flag, is malformed", async () => {
    const approved = await bytesOf("enrollment_approved");
    const refusal = await bytesOf("refusal_rate_limited");

    expect(parseEnrollmentStatus(withByte(approved, 48, 4))).toEqual(MALFORMED);
    expect(parseEnrollmentStatus(withByte(approved, 48, 0))).toEqual(MALFORMED);
    expect(parseRefusal(withByte(refusal, 32, 0))).toEqual(MALFORMED);
    expect(parseRefusal(withByte(refusal, 33, 2))).toEqual(MALFORMED);
});

test("a refusal with a code this build doesn't know decodes, keeping the code's number", async () => {
    const refusal = await bytesOf("refusal_rate_limited");

    expect(parseRefusal(withByte(refusal, 32, 24))).toEqual({
        ok: true,
        value: { code: { unknown: 24 }, retryAfterMs: 30_000 },
    });
});

test("a lease request's answer flag is 0 or 1, and its frame runs from module to server", async () => {
    const request = await bytesOf("lease_request");

    // The flag at 32, the answer at 33, the frame's direction 48 bytes into the frame at 65.
    expect(parseLeaseRequest(withByte(request, 32, 2))).toEqual(MALFORMED);
    expect(parseLeaseRequest(withByte(request, 65 + 48, 2))).toEqual(MALFORMED);
    expect(parseLeaseRequest(request.subarray(0, 64))).toEqual(MALFORMED);
});

test("a lease response's challenge is not empty, and its frame runs from server to module", async () => {
    const response = await bytesOf("lease_response");

    // The challenge's size at 52, the frame's direction 48 bytes into the frame at 56.
    expect(parseLeaseResponse(withBytes(response, 52, new Uint8Array(4)))).toEqual(MALFORMED);
    expect(parseLeaseResponse(withByte(response, 56 + 48, 1))).toEqual(MALFORMED);
});

test("a key exchange with a low-order peer key is refused", async () => {
    const seed = Uint8Array.fromHex(
        "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
    );
    const one = new Uint8Array(32);
    one[0] = 1;

    expect(await sharedSecret(seed, new Uint8Array(32))).toEqual({
        ok: false,
        error: { code: "LOW_ORDER_KEY" },
    });
    expect(await sharedSecret(seed, one)).toEqual({ ok: false, error: { code: "LOW_ORDER_KEY" } });
});
