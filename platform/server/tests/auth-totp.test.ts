import { expect, test } from "bun:test";
import { parseNewPassword } from "../src/auth/password.ts";
import {
    createTotpKeyring,
    openTotpSecret,
    sealTotpSecret,
    totpCode,
    totpStepAt,
} from "../src/auth/totp.ts";
import { err, ok } from "../src/core/result.ts";
import { createSeededRng } from "../src/core/rng.ts";
import { AccountId, EpochMs } from "../src/core/scalars.ts";
import { TEST_TOTP_KEYS } from "./harness/auth.ts";

const ALICE = AccountId.parse(`acc_${"a".repeat(22)}`);
const BOB = AccountId.parse(`acc_${"b".repeat(22)}`);

test("codes match RFC 6238's SHA-1 test vectors", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    // Appendix B lists 8-digit codes; a 6-digit code is the same value mod 10^6.
    for (const [seconds, code] of [
        [59, "287082"],
        [1_111_111_109, "081804"],
        [1_234_567_890, "005924"],
        [20_000_000_000, "353130"],
    ] as const) {
        expect(await totpCode(secret, totpStepAt(EpochMs.parse(seconds * 1_000)))).toBe(code);
    }
});

test("a sealed secret opens only on the account it was sealed for", async () => {
    const keyring = await createTotpKeyring(TEST_TOTP_KEYS);
    const secret = new Uint8Array(20).fill(7);
    const sealed = await sealTotpSecret({
        keyring,
        rng: createSeededRng(401),
        accountId: ALICE,
        secret,
    });
    expect(await openTotpSecret({ keyring, accountId: ALICE, sealed })).toEqual(ok(secret));
    expect(await openTotpSecret({ keyring, accountId: BOB, sealed })).toEqual(
        err({ code: "TOTP_UNREADABLE" }),
    );
});

test("a secret sealed before a key rotation still opens after it", async () => {
    const [newest, previous] = TEST_TOTP_KEYS;
    const before = await createTotpKeyring([previous]);
    const after = await createTotpKeyring([newest, previous]);
    const secret = new Uint8Array(20).fill(9);
    const sealed = await sealTotpSecret({
        keyring: before,
        rng: createSeededRng(402),
        accountId: ALICE,
        secret,
    });
    expect(sealed.kid).toBe(previous.kid);
    expect(await openTotpSecret({ keyring: after, accountId: ALICE, sealed })).toEqual(ok(secret));
    const resealed = await sealTotpSecret({
        keyring: after,
        rng: createSeededRng(403),
        accountId: ALICE,
        secret,
    });
    expect(resealed.kid).toBe(newest.kid);
    expect(await openTotpSecret({ keyring: before, accountId: ALICE, sealed: resealed })).toEqual(
        err({ code: "TOTP_UNREADABLE" }),
    );
});

test("a new password's length counts characters after NFKC, not bytes", () => {
    // Eleven full-width letters fold to eleven ASCII ones: still too short.
    expect(parseNewPassword("ａｂｃｄｅｆｇｈｉｊｋ")).toEqual(
        err({ code: "PASSWORD_REJECTED", reason: "too_short" }),
    );
    // Twelve emoji are 48 UTF-8 bytes but twelve characters.
    expect(parseNewPassword("🔑".repeat(12)).ok).toBe(true);
    expect(parseNewPassword("x".repeat(129))).toEqual(
        err({ code: "PASSWORD_REJECTED", reason: "too_long" }),
    );
});
