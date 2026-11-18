import { type AuthDeps, createAuthDeps } from "../../src/auth/deps.ts";
import { createArgon2idHasher } from "../../src/auth/password.ts";
import { createTotpKeyring } from "../../src/auth/totp.ts";
import type { SeededRng } from "../../src/core/rng.ts";
import type { Db } from "../../src/db/pool.ts";
import { TEST_RELYING_PARTY } from "./authenticator.ts";

// The keyring every auth test seals TOTP secrets under: "old" is still listed, so secrets sealed
// before a rotation keep opening.
export const TEST_TOTP_KEYS = [
    { kid: "new", raw: new Uint8Array(32).fill(2) },
    { kid: "old", raw: new Uint8Array(32).fill(1) },
] as const;

// Real argon2id at the smallest cost it accepts: the same code path, without 64 MiB per hash.
export async function createTestAuthDeps(db: Db, rng: SeededRng): Promise<AuthDeps> {
    return createAuthDeps({
        db,
        rng,
        rp: TEST_RELYING_PARTY,
        totpKeys: await createTotpKeyring(TEST_TOTP_KEYS),
        passwords: createArgon2idHasher({ memoryCostKiB: 64, timeCost: 1 }),
    });
}
