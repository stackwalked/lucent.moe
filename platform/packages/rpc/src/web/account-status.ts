// The account statuses without zod, for the browser; authority.ts builds the contract's schema
// from them.

// "setup_pending": no way to sign in yet (no passkey, and not both a password and confirmed
// TOTP), whether new or recovered.
export const ACCOUNT_STATUSES = ["active", "suspended", "locked", "setup_pending"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const isAccountStatus = (value: unknown): value is AccountStatus =>
    ACCOUNT_STATUSES.some((status) => status === value);
