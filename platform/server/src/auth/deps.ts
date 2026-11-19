import type { CryptoRng } from "@lucent/core/rng";
import type { Db } from "../db/pool.ts";
import type { RelyingParty } from "./passkeys.ts";
import { createPasswordVerifier, type PasswordHasher } from "./password.ts";
import type { TotpKeyring } from "./totp.ts";

export type AuthDeps = {
    readonly db: Db;
    readonly rng: CryptoRng;
    readonly rp: RelyingParty;
    readonly totpKeys: TotpKeyring;
    readonly passwords: PasswordHasher;
    readonly verifyPassword: (password: string, hash: string | null) => Promise<boolean>;
    // Dev only (config refuses it off localhost): a password signs in alone, and a caller's
    // step-up is always fresh. Absent is off.
    readonly passwordOnly?: boolean;
};

export function createAuthDeps(params: Omit<AuthDeps, "verifyPassword">): AuthDeps {
    return { ...params, verifyPassword: createPasswordVerifier(params.passwords).verify };
}
