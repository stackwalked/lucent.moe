// Only digits, at most six: what a typed or pasted code is reduced to.
export const CODE_LENGTH = 6;

export function codeDigits(text: string): string {
    return text.replace(/\D/g, "").slice(0, CODE_LENGTH);
}
