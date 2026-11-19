import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@lucent/core/rules";
import { UI_COPY } from "../copy.ts";

// Code points after NFKC, as the server counts them (the input's own minLength counts UTF-16
// units of the raw text, which would disagree on emoji and compatibility forms).
export function passwordLength(value: string): number {
    return [...value.normalize("NFKC")].length;
}

export function passwordHint(count: number): string {
    if (count === 0) return UI_COPY.passwordRange(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH);
    if (count < PASSWORD_MIN_LENGTH) return UI_COPY.passwordShort(count, PASSWORD_MIN_LENGTH);
    if (count > PASSWORD_MAX_LENGTH) return UI_COPY.passwordLong(count, PASSWORD_MAX_LENGTH);
    return UI_COPY.passwordCount(count);
}

// Empty is left to `required`.
export function passwordProblem(value: string): string | undefined {
    const count = passwordLength(value);
    if (count === 0) return undefined;
    if (count < PASSWORD_MIN_LENGTH) return UI_COPY.tooShort(PASSWORD_MIN_LENGTH);
    if (count > PASSWORD_MAX_LENGTH) return UI_COPY.tooLong(PASSWORD_MAX_LENGTH);
    return undefined;
}
