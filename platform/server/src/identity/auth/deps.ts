import type { CryptoRng } from "@lucent/core/rng";
import type { Db } from "../../base/db/pool.ts";
import type { EmailHasher } from "../deletion/email-hash.ts";
import type { BreachCheck } from "./breach.ts";
import type { RelyingParty } from "./passkeys.ts";
import { createPasswordVerifier, type PasswordHasher } from "./password.ts";
import type { TotpKeyring } from "./totp.ts";

export type AuthDeps = {
    readonly db: Db;
    readonly rng: CryptoRng;
    readonly rp: RelyingParty;
    readonly totpKeys: TotpKeyring;
    // Keyed from the same configured secrets as totpKeys (deletion/email-hash.ts says why).
    readonly emailHasher: EmailHasher;
    readonly passwords: PasswordHasher;
    readonly breachCheck: BreachCheck;
    // Whether a mail provider is configured. Without one nothing drains the outbox, so nothing
    // may be queued: an address and message text would sit there for good.
    readonly mailEnabled: boolean;
    readonly verifyPassword: (password: string, hash: string | null) => Promise<boolean>;
    // Dev only (config refuses it off localhost): a password signs in alone, and a caller's
    // step-up is always fresh. Absent is off.
    readonly passwordOnly?: boolean;
};

export function createAuthDeps(params: Omit<AuthDeps, "verifyPassword">): AuthDeps {
    return { ...params, verifyPassword: createPasswordVerifier(params.passwords).verify };
}
