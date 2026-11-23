import { expect, test } from "bun:test";
import { z } from "zod";
import { regexes } from "zod/v4/core";
import { EMAIL_PATTERN, isEmail, isUuid, UUID_PATTERN } from "../src/formats.ts";

// The browser's copies of zod's email and uuid patterns: one that drifts from the zod platform
// parses with lets the add-account form pass an address platform refuses, or the inbox refuse a
// cursor platform handed out.

test("the email and uuid patterns are the ones zod checks with", () => {
    // Biome drops the escape from "\-" inside a character class, which matches the same "-".
    expect(EMAIL_PATTERN.source).toBe(regexes.email.source.replaceAll("\\-", "-"));
    expect(EMAIL_PATTERN.flags).toBe(regexes.email.flags);
    expect(UUID_PATTERN.source).toBe(regexes.uuid().source);
    expect(UUID_PATTERN.flags).toBe(regexes.uuid().flags);
});

test("an address or uuid passes here exactly when it passes zod", () => {
    for (const candidate of [
        "a@b.co",
        "a@b",
        "a.b+c@d-e.fg",
        "-a@b.co",
        "a-@b.co",
        "a..b@c.de",
        ".a@b.co",
        "a@-b.co",
        "a@b.c",
        "a'b@c.de",
        "a b@c.de",
        "ä@b.co",
        "",
        5,
        null,
    ]) {
        expect([candidate, isEmail(candidate)]).toEqual([
            candidate,
            z.email().safeParse(candidate).success,
        ]);
    }
    for (const candidate of [
        "123e4567-e89b-12d3-a456-426614174000",
        "123E4567-E89B-12D3-A456-426614174000",
        "123e4567-e89b-02d3-a456-426614174000",
        "123e4567-e89b-12d3-c456-426614174000",
        "00000000-0000-0000-0000-000000000000",
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "123e4567e89b12d3a456426614174000",
        "123e4567-e89b-12d3-a456-42661417400",
        "",
        1,
        undefined,
    ]) {
        expect([candidate, isUuid(candidate)]).toEqual([
            candidate,
            z.uuid().safeParse(candidate).success,
        ]);
    }
});
