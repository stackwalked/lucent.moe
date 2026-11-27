import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import { toBase64Url } from "@lucent/core/scalars";
import { parseKeyset, toKeyset } from "../src/base/db/keyset.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const encode = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

test("a cursor round-trips whole microseconds and an id", () => {
    const key = { micros: "1767225600123456", id: ID };
    expect(parseKeyset(toKeyset(key))).toEqual(ok(key));
});

test.each([
    ["empty", ""],
    ["not base64", "not a cursor!"],
    ["a bare id", ID],
    ["a json string", encode(ID)],
    ["fractional micros", encode(["1.5", ID])],
    ["micros as a number", encode([1767225600123456, ID])],
    ["an id that is not a uuid", encode(["1767225600123456", "not-a-uuid"])],
    ["micros too long to be a time", encode(["12345678901234567", ID])],
    ["a longer tuple", encode(["1", ID, "extra"])],
])("a cursor that is %s is invalid", (_name, cursor) => {
    expect(parseKeyset(cursor)).toEqual(err({ code: "INVALID_CURSOR" }));
});
