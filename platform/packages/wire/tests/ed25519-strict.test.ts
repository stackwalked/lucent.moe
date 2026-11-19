import { expect, test } from "bun:test";
import { z } from "zod";
import { isStrictlySignedBy } from "../src/strict-signature.ts";
import { hexAny, hexBytes, readContractJson } from "./fixtures.ts";

// contracts/ed25519/v1/strict.json, written by native/libs/crypto/tests/strict_vectors_test.cpp:
// signatures a lax Ed25519 verifier accepts and a strict one refuses, beside one valid signature.
// Both sides must refuse every one marked invalid.

const Strict = z.strictObject({
    cases: z.array(
        z.strictObject({
            name: z.string(),
            is_valid: z.boolean(),
            defect: z.string(),
            public_key: hexBytes(32),
            message: hexAny,
            signature: hexBytes(64),
        }),
    ),
});

const { cases } = Strict.parse(await readContractJson("ed25519", "strict.json"));

for (const each of cases) {
    const verdict = each.is_valid ? "accepts" : "refuses";
    test(`strict verification ${verdict} ${each.name}${each.is_valid ? "" : `: ${each.defect}`}`, async () => {
        expect(await isStrictlySignedBy(each.public_key, each.message, each.signature)).toBe(
            each.is_valid,
        );
    });
}
