import { err, ok, type Result } from "../core/result.ts";

export type PasswordHasher = {
    readonly hash: (password: string) => Promise<string>;
    readonly verify: (password: string, hash: string) => Promise<boolean>;
};

// argon2id through Bun.password; production takes the defaults below (64 MiB, 3 passes). Tests
// pass cheaper parameters: same algorithm and code path, just faster.
export function createArgon2idHasher(params?: {
    readonly memoryCostKiB?: number;
    readonly timeCost?: number;
}): PasswordHasher {
    const options = {
        algorithm: "argon2id" as const,
        memoryCost: params?.memoryCostKiB ?? 65_536,
        timeCost: params?.timeCost ?? 3,
    };
    return {
        hash: (password) => Bun.password.hash(password, options),
        verify: (password, hash) => Bun.password.verify(password, hash),
    };
}

export type PasswordRejected = {
    readonly code: "PASSWORD_REJECTED";
    readonly reason: "too_short" | "too_long";
};

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

// NFKC so the same password typed on two keyboards is the same password; length counts code
// points, since that's what a person counts.
export function parseNewPassword(raw: string): Result<string, PasswordRejected> {
    const normalized = raw.normalize("NFKC");
    const length = [...normalized].length;
    if (length < MIN_LENGTH) return err({ code: "PASSWORD_REJECTED", reason: "too_short" });
    if (length > MAX_LENGTH) return err({ code: "PASSWORD_REJECTED", reason: "too_long" });
    return ok(normalized);
}

export function normalizePasswordAttempt(raw: string): string {
    return raw.normalize("NFKC");
}

// Verifies against a real hash when the account has none (or doesn't exist), so "no such user"
// and "wrong password" cost the same and take the same path.
export function createPasswordVerifier(hasher: PasswordHasher): {
    readonly verify: (password: string, hash: string | null) => Promise<boolean>;
} {
    let dummy: Promise<string> | null = null;
    return {
        verify: async (password, hash) => {
            if (hash !== null) return await hasher.verify(password, hash);
            dummy ??= hasher.hash("lucent-dummy-password-for-equal-timing");
            await hasher.verify(password, await dummy);
            return false;
        },
    };
}
