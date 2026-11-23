// Text formats the browser checks as platform's zod does, without loading zod into a page. The
// patterns are zod 4.6.7's own (v4/core/regexes.js: email, and uuid() with no version, behind
// z.email() and z.uuid()); tests/formats.test.ts fails if a zod upgrade changes them, which
// would let the browser pass what platform refuses, or refuse what it takes.

export const EMAIL_PATTERN =
    /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export const UUID_PATTERN =
    /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

export const isEmail = (value: unknown): value is string =>
    typeof value === "string" && EMAIL_PATTERN.test(value);

export const isUuid = (value: unknown): value is string =>
    typeof value === "string" && UUID_PATTERN.test(value);
