import { err, ok, type Result } from "@lucent/core/result";

const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,23}$/;
const MIN_ALPHANUMERIC = 3;

// Every entry in Unicode confusables.txt 18.0.0 (UTS #39) whose source can appear in a username
// once case is folded (usernames are case-insensitive, so a character confusable with either
// case of a letter folds to it): 0 -> O, 1 -> l, I -> l, m -> rn. Every other [a-z0-9] character
// is its own prototype there. Widening USERNAME_PATTERN means re-deriving this table.
const PROTOTYPES: ReadonlyMap<string, string> = new Map([
    ["0", "o"],
    ["1", "l"],
    ["i", "l"],
    ["m", "rn"],
]);

export type UsernameInvalid = {
    readonly code: "INVALID_USERNAME";
    readonly detail: string;
};

export type ParsedUsername = {
    readonly username: string;
    readonly skeleton: string;
};

// "_" is dropped: a separator carries no identity, so "mi_ka" impersonates "mika".
export function usernameSkeleton(username: string): string {
    let out = "";
    for (const ch of username) {
        if (ch === "_") continue;
        out += PROTOTYPES.get(ch) ?? ch;
    }
    return out;
}

export function parseUsername(raw: string): Result<ParsedUsername, UsernameInvalid> {
    const username = raw.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(username)) {
        return err({
            code: "INVALID_USERNAME",
            detail: "username must be 3..24 chars of [a-z0-9_], starting with a letter",
        });
    }
    if (username.replaceAll("_", "").length < MIN_ALPHANUMERIC) {
        return err({
            code: "INVALID_USERNAME",
            detail: "username must contain at least 3 letters or digits",
        });
    }
    return ok({ username, skeleton: usernameSkeleton(username) });
}
