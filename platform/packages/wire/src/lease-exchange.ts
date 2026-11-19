import { createWriter, type FormatError, malformed, openReader } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import { ok, type Result } from "@lucent/core/result";
import { readContext, readFlag, writeContext } from "./codec.ts";
import { type Frame, parseFrame, toFrameBytes } from "./frame.ts";
import { CHALLENGE_ANSWER_SIZE, CHALLENGE_NONCE_SIZE, type HashChallenge } from "./lease.ts";

// The bodies of POST /v1/sessions/:id/lease, as native/libs/wire/src/lease.cpp reads and writes
// them: the module's frame behind the loader's own part, outside the module's AEAD so the loader
// can read and write it. The server names a range of the module's image, the loader hashes it from
// outside the module's process, and its answer rides the next renewal. Disagreement with the
// module's own answer is a signal; neither ever changes what the client sees.
//
// Version 1 on the wire:
//   request: context "lucent lease request v1" (32), u8 has loader answer (0 or 1), loader
//     answer (32) after 1 only, then a frame (module to server) running to the end.
//   response: context "lucent lease response v1" (32), loader challenge nonce (16), u32 offset,
//     u32 size, then a frame (server to module) running to the end.

const REQUEST_VERSION = 1;
const RESPONSE_VERSION = 1;

export type LeaseRequest = {
    // None before the first lease response.
    readonly loaderAnswer: Uint8Array | null;
    readonly renewal: Frame;
};

export type LeaseResponse = {
    readonly loaderChallenge: HashChallenge;
    readonly lease: Frame;
};

function join(head: Uint8Array, frame: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(head.byteLength + frame.byteLength);
    out.set(head);
    out.set(frame, head.byteLength);
    return out;
}

export function toLeaseRequestBytes(request: LeaseRequest): Uint8Array<ArrayBuffer> {
    invariant(request.renewal.header.direction === "module_to_server", "renewal direction");
    const out = createWriter();
    writeContext(out, "lease request", REQUEST_VERSION);
    if (request.loaderAnswer === null) {
        out.u8(0);
    } else {
        invariant(request.loaderAnswer.byteLength === CHALLENGE_ANSWER_SIZE, "answer size");
        out.u8(1);
        out.bytes(request.loaderAnswer);
    }
    return join(out.finish(), toFrameBytes(request.renewal));
}

// Canonical or nothing: an answer flag of 0 or 1, a frame from module to server running to the end.
export function parseLeaseRequest(bytes: Uint8Array): Result<LeaseRequest, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "lease request", REQUEST_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 1) {
        return malformed();
    }
    const hasAnswer = readFlag(input);
    if (hasAnswer === null || (hasAnswer && input.remaining() < CHALLENGE_ANSWER_SIZE)) {
        return malformed();
    }
    const loaderAnswer = hasAnswer ? input.bytes(CHALLENGE_ANSWER_SIZE) : null;
    const renewal = parseFrame(input.bytes(input.remaining()));
    if (!renewal.ok) {
        return renewal;
    }
    if (renewal.value.header.direction !== "module_to_server") {
        return malformed();
    }
    return ok({ loaderAnswer, renewal: renewal.value });
}

export function toLeaseResponseBytes(response: LeaseResponse): Uint8Array<ArrayBuffer> {
    const challenge = response.loaderChallenge;
    invariant(response.lease.header.direction === "server_to_module", "lease direction");
    invariant(challenge.nonce.byteLength === CHALLENGE_NONCE_SIZE, "challenge nonce size");
    invariant(challenge.size > 0, "empty challenge");
    const out = createWriter();
    writeContext(out, "lease response", RESPONSE_VERSION);
    out.bytes(challenge.nonce);
    out.u32(challenge.offset);
    out.u32(challenge.size);
    return join(out.finish(), toFrameBytes(response.lease));
}

// Canonical or nothing: a non-zero challenge size, a frame from server to module running to the end.
export function parseLeaseResponse(bytes: Uint8Array): Result<LeaseResponse, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "lease response", RESPONSE_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < CHALLENGE_NONCE_SIZE + 4 + 4) {
        return malformed();
    }
    const loaderChallenge = {
        nonce: input.bytes(CHALLENGE_NONCE_SIZE),
        offset: input.u32(),
        size: input.u32(),
    };
    const lease = parseFrame(input.bytes(input.remaining()));
    if (!lease.ok) {
        return lease;
    }
    if (loaderChallenge.size === 0 || lease.value.header.direction !== "server_to_module") {
        return malformed();
    }
    return ok({ loaderChallenge, lease: lease.value });
}
