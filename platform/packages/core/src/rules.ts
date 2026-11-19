// Limits a browser checks for instant feedback and the server enforces, from one place so the
// two can't drift.

// Counted in code points after NFKC, since that's what a person counts.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Lowercase, a letter first, 3 to 24 characters of a-z, 0-9 and "_", at least 3 of them letters
// or digits. The HTML `pattern` can't count the underscores, so the server checks that part.
export const USERNAME_PATTERN = "[a-z][a-z0-9_]{2,23}";
export const USERNAME_MIN_ALPHANUMERIC = 3;
