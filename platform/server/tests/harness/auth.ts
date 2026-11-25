import type { SeededRng } from "@lucent/core/rng";
import { TEST_RELYING_PARTY } from "@lucent/testing/authenticator";
import type { BreachCheck } from "../../src/auth/breach.ts";
import { type AuthDeps, createAuthDeps } from "../../src/auth/deps.ts";
import { createArgon2idHasher } from "../../src/auth/password.ts";
import { createTotpKeyring } from "../../src/auth/totp.ts";
import type { Db } from "../../src/db/pool.ts";
import { createEmailHasher } from "../../src/deletion/email-hash.ts";

// The keyring every auth test seals TOTP secrets under: "old" is still listed, so secrets sealed
// before a rotation keep opening.
export const TEST_TOTP_KEYS = [
    { kid: "new", raw: new Uint8Array(32).fill(2) },
    { kid: "old", raw: new Uint8Array(32).fill(1) },
] as const;

// No network in tests: the breach check itself is tested against a stand-in for the range API.
export const NEVER_BREACHED: BreachCheck = () => Promise.resolve("clear");

// Real argon2id at the smallest cost it accepts: the same code path, without 64 MiB per hash.
export async function createTestAuthDeps(db: Db, rng: SeededRng): Promise<AuthDeps> {
    return createAuthDeps({
        db,
        rng,
        rp: TEST_RELYING_PARTY,
        totpKeys: await createTotpKeyring(TEST_TOTP_KEYS),
        emailHasher: await createEmailHasher(TEST_TOTP_KEYS),
        passwords: createArgon2idHasher({ memoryCostKiB: 64, timeCost: 1 }),
        breachCheck: NEVER_BREACHED,
        mailEnabled: true,
    });
}
