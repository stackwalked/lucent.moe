import { expect, test } from "bun:test";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { z } from "zod";
import {
    parseDataRequest,
    parseDataResponse,
    toDataRequestBytes,
    toDataResponseBytes,
} from "../src/data.ts";
import {
    parseEnrollmentRequest,
    parseEnrollmentStatus,
    toEnrollmentRequestBytes,
    toEnrollmentStatusBytes,
} from "../src/enrollment.ts";
import { openFrame, parseFrame, sealFrame, toAssociatedData, toFrameBytes } from "../src/frame.ts";
import {
    type Lease,
    parseLease,
    parseLeaseRenewal,
    toLeaseBytes,
    toLeaseRenewalBytes,
    toLeaseSignedBytes,
} from "../src/lease.ts";
import {
    parseLeaseRequest,
    parseLeaseResponse,
    toLeaseRequestBytes,
    toLeaseResponseBytes,
} from "../src/lease-exchange.ts";
import { parseRefusal, REFUSAL_CODES, toRefusalBytes } from "../src/refusal.ts";
import {
    deriveSessionKeys,
    parseSessionHello,
    parseSessionReply,
    toExchangeSignedBytes,
    toSessionHelloBytes,
    toSessionReplyBytes,
} from "../src/session.ts";
import { exchangePublicKey, sharedSecret, signWithSeed } from "../src/session-crypto.ts";
import {
    parseStartReply,
    parseStartRequest,
    toStartReplyBytes,
    toStartRequestBytes,
} from "../src/start.ts";
import { isStrictlySignedBy } from "../src/strict-signature.ts";
import {
    bigintNumber,
    hexAny,
    hexBytes,
    hexU32,
    hexU64,
    readContractFile,
    readContractJson,
} from "./fixtures.ts";

// contracts/wire/v1, written by native/libs/wire/tests/vectors_test.cpp: each .json states its
// .bin's contents. The session reply and renewal frame also state the secrets behind them, which
// check this side's X25519, key derivation and Ed25519 signing against Monocypher's. Their
// ciphertexts are checked only for shape: Bun has no XChaCha20-Poly1305 to open them with.

async function vector<T extends z.ZodType>(name: string, schema: T) {
    return {
        bytes: new Uint8Array(await readContractFile("wire", `${name}.bin`)),
        stated: schema.parse(await readContractJson("wire", `${name}.json`)),
    };
}

const Frame = z
    .strictObject({
        session: hexBytes(16),
        direction: z.enum(["module_to_server", "server_to_module"]),
        sequence: bigintNumber,
        nonce: hexBytes(24),
        sealed: hexAny,
        associated_data: hexAny,
    })
    .transform(({ associated_data, session, direction, sequence, ...rest }) => ({
        frame: { header: { session, direction, sequence }, ...rest },
        associatedData: associated_data,
    }));

const LeaseFields = z
    .strictObject({
        session: hexBytes(16),
        device: hexBytes(16),
        release: hexBytes(16),
        sequence: bigintNumber,
        nonce: hexBytes(16),
        duration_ms: z.number().int(),
        data_revision: bigintNumber,
        challenge: z.strictObject({
            nonce: hexBytes(16),
            offset: z.number().int(),
            size: z.number().int(),
        }),
        product: z.string(),
        everything: z.boolean(),
        features: z.array(hexU64),
        signature: hexBytes(64),
    })
    .transform(
        ({ duration_ms, data_revision, everything, features, ...rest }): Lease => ({
            ...rest,
            durationMs: duration_ms,
            dataRevision: data_revision,
            entitled: everything ? { everything: true } : { everything: false, features },
        }),
    );

const ModuleKeys = z.array(
    z
        .strictObject({ name_hash: hexU64, time_date_stamp: hexU32, size_of_image: hexU32 })
        .transform((module) => ({
            nameHash: module.name_hash,
            timeDateStamp: module.time_date_stamp,
            sizeOfImage: module.size_of_image,
        })),
);

const DataResponseFields = z
    .strictObject({
        data_revision: bigintNumber,
        bundle: hexAny,
        unsupported: ModuleKeys,
    })
    .transform(({ data_revision, ...rest }) => ({ dataRevision: data_revision, ...rest }));

const DataRequestVector = z.strictObject({
    modules: ModuleKeys,
    features: z.array(hexU64).nullable(),
});

const SessionReplyVector = z.strictObject({
    exchange: z.strictObject({
        session: hexBytes(16),
        module_key: hexBytes(32),
        nonce: hexBytes(16),
        server_key: hexBytes(32),
        signature: hexBytes(64),
    }),
    first_lease_frame: Frame,
    first_lease_plain: hexAny,
    first_lease: LeaseFields,
    first_data_frame: Frame,
    first_data_plain: hexAny,
    first_data: DataResponseFields,
    secrets: z.strictObject({
        lease_public_key: hexBytes(32),
        module_seed: hexBytes(32),
        server_seed: hexBytes(32),
        shared_secret: hexBytes(32),
        lease_module_to_server_key: hexBytes(32),
        lease_server_to_module_key: hexBytes(32),
        data_module_to_server_key: hexBytes(32),
        data_server_to_module_key: hexBytes(32),
        reports_module_to_server_key: hexBytes(32),
        reports_server_to_module_key: hexBytes(32),
    }),
});

test("the session hello vector decodes to what it states, and encodes back to its bytes", async () => {
    const { bytes, stated } = await vector(
        "session_hello",
        z.strictObject({
            module_key: hexBytes(32),
            nonce: hexBytes(16),
            release: hexBytes(16),
            boot_info_version: z.number().int(),
            image_kind: z.enum(["loaded", "mapped"]),
            image_base: hexU64,
            image_size: z.number().int(),
        }),
    );
    const hello = {
        moduleKey: stated.module_key,
        nonce: stated.nonce,
        release: stated.release,
        boot: {
            bootInfoVersion: stated.boot_info_version,
            imageKind: stated.image_kind,
            imageBase: stated.image_base,
            imageSize: stated.image_size,
        },
    };

    expect(parseSessionHello(bytes)).toEqual({ ok: true, value: hello });
    expect(toSessionHelloBytes(hello)).toEqual(bytes);
});

test("the session reply vector decodes to what it states, and encodes back to its bytes", async () => {
    const { bytes, stated } = await vector("session_reply", SessionReplyVector);
    const reply = {
        exchange: {
            session: stated.exchange.session,
            moduleKey: stated.exchange.module_key,
            nonce: stated.exchange.nonce,
            serverKey: stated.exchange.server_key,
            signature: stated.exchange.signature,
        },
        firstLease: stated.first_lease_frame.frame,
        firstData: stated.first_data_frame.frame,
    };

    expect(parseSessionReply(bytes)).toEqual({ ok: true, value: reply });
    expect(toSessionReplyBytes(reply)).toEqual(bytes);
    expect(toAssociatedData(reply.firstLease.header)).toEqual(
        stated.first_lease_frame.associatedData,
    );
    expect(toAssociatedData(reply.firstData.header)).toEqual(
        stated.first_data_frame.associatedData,
    );
});

test("X25519 and the six session keys' derivation agree with the session reply vector's secrets", async () => {
    const { stated } = await vector("session_reply", SessionReplyVector);
    const { secrets, exchange } = stated;

    const moduleKey = await exchangePublicKey(secrets.module_seed);
    const serverKey = await exchangePublicKey(secrets.server_seed);
    const moduleShared = await sharedSecret(secrets.module_seed, serverKey);
    const serverShared = await sharedSecret(secrets.server_seed, moduleKey);

    expect(moduleKey).toEqual(exchange.module_key);
    expect(serverKey).toEqual(exchange.server_key);
    expect(moduleShared).toEqual({ ok: true, value: secrets.shared_secret });
    expect(serverShared).toEqual({ ok: true, value: secrets.shared_secret });
    expect(deriveSessionKeys({ shared: secrets.shared_secret, moduleKey, serverKey })).toEqual({
        lease: {
            moduleToServer: secrets.lease_module_to_server_key,
            serverToModule: secrets.lease_server_to_module_key,
        },
        data: {
            moduleToServer: secrets.data_module_to_server_key,
            serverToModule: secrets.data_server_to_module_key,
        },
        reports: {
            moduleToServer: secrets.reports_module_to_server_key,
            serverToModule: secrets.reports_server_to_module_key,
        },
    });
});

test("the session reply vector's exchange and lease are signed by the lease key, as this side signs", async () => {
    const { stated } = await vector("session_reply", SessionReplyVector);
    const leaseSeed = Uint8Array.fromHex(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    );
    const exchange = {
        session: stated.exchange.session,
        moduleKey: stated.exchange.module_key,
        nonce: stated.exchange.nonce,
        serverKey: stated.exchange.server_key,
        signature: stated.exchange.signature,
    };
    const exchangeBytes = toExchangeSignedBytes(exchange);
    const leaseBytes = toLeaseSignedBytes(stated.first_lease);
    const key = stated.secrets.lease_public_key;

    expect(await isStrictlySignedBy(key, exchangeBytes, exchange.signature)).toBe(true);
    expect(await isStrictlySignedBy(key, leaseBytes, stated.first_lease.signature)).toBe(true);
    expect(await signWithSeed(leaseSeed, exchangeBytes)).toEqual(exchange.signature);
    expect(await signWithSeed(leaseSeed, leaseBytes)).toEqual(
        new Uint8Array(stated.first_lease.signature),
    );
});

test("the session reply vector's lease plaintext decodes to the lease it states, and back", async () => {
    const { stated } = await vector("session_reply", SessionReplyVector);

    expect(parseLease(stated.first_lease_plain)).toEqual({ ok: true, value: stated.first_lease });
    expect(toLeaseBytes(stated.first_lease)).toEqual(stated.first_lease_plain);
});

test("the session reply vector's data plaintext decodes to the response it states, and back", async () => {
    const { stated } = await vector("session_reply", SessionReplyVector);

    expect(parseDataResponse(stated.first_data_plain)).toEqual({
        ok: true,
        value: stated.first_data,
    });
    expect(toDataResponseBytes(stated.first_data)).toEqual(stated.first_data_plain);
});

test("the data vectors decode to what they state, and encode back to their bytes", async () => {
    for (const name of ["data_request", "data_request_everything"]) {
        const { bytes, stated } = await vector(name, DataRequestVector);

        expect(parseDataRequest(bytes)).toEqual({ ok: true, value: stated });
        expect(toDataRequestBytes(stated)).toEqual(bytes);
    }
    const response = await vector("data_response", DataResponseFields);

    expect(parseDataResponse(response.bytes)).toEqual({ ok: true, value: response.stated });
    expect(toDataResponseBytes(response.stated)).toEqual(response.bytes);
});

test("the everything lease vector decodes to what it states, and encodes back to its bytes", async () => {
    const { bytes, stated } = await vector("lease_everything", LeaseFields);

    expect(parseLease(bytes)).toEqual({ ok: true, value: stated });
    expect(toLeaseBytes(stated)).toEqual(bytes);
});

test("the renewal frame vector decodes to what it states, and its renewal plaintext too", async () => {
    const { bytes, stated } = await vector(
        "renewal_frame",
        z.strictObject({
            frame: Frame,
            renewal_plain: hexAny,
            renewal: z.strictObject({
                sequence: bigintNumber,
                nonce: hexBytes(16),
                challenge_answer: hexBytes(32),
                signals: hexBytes(64),
            }),
        }),
    );
    const renewal = {
        sequence: stated.renewal.sequence,
        nonce: stated.renewal.nonce,
        challengeAnswer: stated.renewal.challenge_answer,
        signals: stated.renewal.signals,
    };

    expect(parseFrame(bytes)).toEqual({ ok: true, value: stated.frame.frame });
    expect(toFrameBytes(stated.frame.frame)).toEqual(bytes);
    expect(toAssociatedData(stated.frame.frame.header)).toEqual(stated.frame.associatedData);
    expect(parseLeaseRenewal(stated.renewal_plain)).toEqual({ ok: true, value: renewal });
    expect(toLeaseRenewalBytes(renewal)).toEqual(stated.renewal_plain);
});

test("the start vectors decode to what they state, and encode back to their bytes", async () => {
    const request = await vector(
        "start_request",
        z.strictObject({
            product: z.string(),
            channel: z.enum(["stable", "alpha", "debug"]),
            loader_release: hexBytes(16),
            modules: z.array(
                z
                    .strictObject({
                        name_hash: hexU64,
                        time_date_stamp: hexU32,
                        size_of_image: hexU32,
                    })
                    .transform((module) => ({
                        nameHash: module.name_hash,
                        timeDateStamp: module.time_date_stamp,
                        sizeOfImage: module.size_of_image,
                    })),
            ),
        }),
    );
    const reply = await vector(
        "start_reply",
        z.strictObject({ start: hexBytes(16), container_key: hexBytes(32), release_seal: hexAny }),
    );
    const startRequest = {
        product: request.stated.product,
        channel: request.stated.channel,
        loaderRelease: request.stated.loader_release,
        modules: request.stated.modules,
    };
    const startReply = {
        start: reply.stated.start,
        containerKey: reply.stated.container_key,
        releaseSeal: reply.stated.release_seal,
    };

    expect(parseStartRequest(request.bytes)).toEqual({ ok: true, value: startRequest });
    expect(toStartRequestBytes(startRequest)).toEqual(request.bytes);
    expect(parseStartReply(reply.bytes)).toEqual({ ok: true, value: startReply });
    expect(toStartReplyBytes(startReply)).toEqual(reply.bytes);
});

test("the enrollment vectors decode to what they state, and encode back to their bytes", async () => {
    const request = await vector(
        "enrollment_request",
        z.strictObject({ storage: z.enum(["tpm", "software"]) }),
    );
    const Status = z.union([
        z.strictObject({
            enrollment: hexBytes(16),
            state: z.enum(["pending", "denied", "expired"]),
            device: z.null(),
        }),
        z.strictObject({
            enrollment: hexBytes(16),
            state: z.literal("approved"),
            device: hexBytes(16),
        }),
    ]);

    expect(parseEnrollmentRequest(request.bytes)).toEqual({ ok: true, value: request.stated });
    expect(toEnrollmentRequestBytes(request.stated)).toEqual(request.bytes);
    for (const name of ["enrollment_pending", "enrollment_approved"]) {
        const { bytes, stated } = await vector(name, Status);
        const status =
            stated.state === "approved"
                ? stated
                : { enrollment: stated.enrollment, state: stated.state };

        expect(parseEnrollmentStatus(bytes)).toEqual({ ok: true, value: status });
        expect(toEnrollmentStatusBytes(status)).toEqual(bytes);
    }
});

test("the refusal vectors decode to what they state, and encode back to their bytes", async () => {
    for (const name of ["refusal_slot_taken", "refusal_rate_limited", "refusal_unknown"]) {
        const { bytes, stated } = await vector(
            name,
            z.strictObject({
                code: z.enum([...REFUSAL_CODES, "UNKNOWN"]),
                raw_code: z.number().int(),
                retry_after_ms: z.number().int().nullable(),
            }),
        );
        const code = stated.code === "UNKNOWN" ? { unknown: stated.raw_code } : stated.code;
        const refusal = { code, retryAfterMs: stated.retry_after_ms };

        expect(parseRefusal(bytes)).toEqual({ ok: true, value: refusal });
        expect(toRefusalBytes(refusal)).toEqual(bytes);
        expect(bytes[32]).toBe(stated.raw_code);
    }
});

const LeaseRequestVector = z.strictObject({
    loader_answer: hexBytes(32).nullable(),
    renewal_frame: Frame,
});

const LeaseResponseVector = z.strictObject({
    loader_challenge: z.strictObject({
        nonce: hexBytes(16),
        offset: z.number().int(),
        size: z.number().int(),
    }),
    lease_frame: Frame,
    lease_plain: hexAny,
    lease: LeaseFields,
});

test("the lease request and response vectors decode to what they state, and encode back", async () => {
    const request = await vector("lease_request", LeaseRequestVector);
    const response = await vector("lease_response", LeaseResponseVector);
    const leaseRequest = {
        loaderAnswer: request.stated.loader_answer,
        renewal: request.stated.renewal_frame.frame,
    };
    const leaseResponse = {
        loaderChallenge: response.stated.loader_challenge,
        lease: response.stated.lease_frame.frame,
    };

    expect(parseLeaseRequest(request.bytes)).toEqual({ ok: true, value: leaseRequest });
    expect(toLeaseRequestBytes(leaseRequest)).toEqual(request.bytes);
    expect(parseLeaseResponse(response.bytes)).toEqual({ ok: true, value: leaseResponse });
    expect(toLeaseResponseBytes(leaseResponse)).toEqual(response.bytes);
    expect(parseLease(response.stated.lease_plain)).toEqual({
        ok: true,
        value: response.stated.lease,
    });
});

// The server's side of the AEAD: what Monocypher sealed opens here to the stated plaintext, and
// sealing that plaintext with the same key, header and nonce gives the same frame byte for byte.
test("the server opens every golden frame and seals the same frames from the same inputs", async () => {
    const reply = await vector("session_reply", SessionReplyVector);
    const renewal = await vector(
        "renewal_frame",
        z.strictObject({ frame: Frame, renewal_plain: hexAny, renewal: z.unknown() }),
    );
    const response = await vector("lease_response", LeaseResponseVector);
    const secrets = reply.stated.secrets;
    const frames = [
        {
            key: secrets.lease_server_to_module_key,
            frame: reply.stated.first_lease_frame.frame,
            plain: reply.stated.first_lease_plain,
        },
        {
            key: secrets.data_server_to_module_key,
            frame: reply.stated.first_data_frame.frame,
            plain: reply.stated.first_data_plain,
        },
        {
            key: secrets.lease_module_to_server_key,
            frame: renewal.stated.frame.frame,
            plain: renewal.stated.renewal_plain,
        },
        {
            key: secrets.lease_server_to_module_key,
            frame: response.stated.lease_frame.frame,
            plain: response.stated.lease_plain,
        },
    ];

    for (const { key, frame, plain } of frames) {
        expect(openFrame(key, frame)).toEqual({ ok: true, value: plain });
        expect(sealFrame(key, { header: frame.header, nonce: frame.nonce, plain })).toEqual(frame);
    }
});

test("a golden frame opens under nothing but its own key and header", async () => {
    const reply = await vector("session_reply", SessionReplyVector);
    const frame = reply.stated.first_lease_frame.frame;
    const secrets = reply.stated.secrets;
    const unauthentic = { ok: false, error: { code: "UNAUTHENTIC" } } as const;

    expect(openFrame(secrets.lease_server_to_module_key, frame)).toEqual({
        ok: true,
        value: reply.stated.first_lease_plain,
    });
    expect(openFrame(secrets.lease_module_to_server_key, frame)).toEqual(unauthentic);
    expect(openFrame(secrets.data_server_to_module_key, frame)).toEqual(unauthentic);
    expect(openFrame(secrets.reports_server_to_module_key, frame)).toEqual(unauthentic);
    expect(
        openFrame(secrets.lease_server_to_module_key, {
            ...frame,
            header: { ...frame.header, sequence: 1n },
        }),
    ).toEqual(unauthentic);
    expect(
        openFrame(secrets.lease_server_to_module_key, {
            ...frame,
            header: { ...frame.header, direction: "module_to_server" },
        }),
    ).toEqual(unauthentic);
});
// draft-irtf-cfrg-xchacha-03, appendix A.3.1: the vector native/libs/crypto checks Monocypher with.
test("sealing gives the XChaCha20-Poly1305 draft's ciphertext and tag", () => {
    const key = Uint8Array.fromHex(
        "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f",
    );
    const nonce = Uint8Array.fromHex("404142434445464748494a4b4c4d4e4f5051525354555657");
    const associated = Uint8Array.fromHex("50515253c0c1c2c3c4c5c6c7");
    const plain = new TextEncoder().encode(
        "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const sealed = Uint8Array.fromHex(
        "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49",
    );

    const cipher = xchacha20poly1305(key, nonce, associated);

    expect(cipher.encrypt(plain)).toEqual(sealed);
    expect(xchacha20poly1305(key, nonce, associated).decrypt(sealed)).toEqual(plain);
});
