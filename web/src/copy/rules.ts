import {
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    USERNAME_MAX_LENGTH,
    USERNAME_MIN_LENGTH,
} from "@lucent/core/rules";

// The limits in words, built from core's numbers, so what a page says is what's checked.
export const RULES_COPY = {
    username: `${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters: a–z, 0–9 and _, starting with a letter`,
    password: `${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`,
} as const;
