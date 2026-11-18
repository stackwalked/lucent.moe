import type { CryptoRng } from "../core/rng.ts";
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
};

export function createAuthDeps(params: Omit<AuthDeps, "verifyPassword">): AuthDeps {
    return { ...params, verifyPassword: createPasswordVerifier(params.passwords).verify };
}
