import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import { ProductId } from "@lucent/core/scalars";
import {
    type ChangelogEntryFields,
    decideChangelogEntry,
} from "../src/members/record/notes.rules.ts";

const CS2 = ProductId.parse("cs2");

function fields(over: Partial<ChangelogEntryFields>): ChangelogEntryFields {
    return {
        subject: "service",
        productId: null,
        version: null,
        title: "one",
        added: [],
        changed: [],
        fixed: [],
        body: "text",
        ...over,
    };
}

const INVALID = err({ code: "INVALID_ENTRY" });

test("a productId exactly when the subject is a product", () => {
    expect(decideChangelogEntry(fields({}))).toEqual(ok(fields({})));
    expect(decideChangelogEntry(fields({ subject: "product", productId: null }))).toEqual(INVALID);
    expect(decideChangelogEntry(fields({ subject: "product", productId: CS2 })).ok).toBe(true);
    expect(decideChangelogEntry(fields({ subject: "loader", productId: CS2 }))).toEqual(INVALID);
    expect(decideChangelogEntry(fields({ subject: "service", productId: CS2 }))).toEqual(INVALID);
});

test("a version or a title names the entry", () => {
    expect(decideChangelogEntry(fields({ title: null, version: null }))).toEqual(INVALID);
    expect(decideChangelogEntry(fields({ title: null, version: "0.8.3" })).ok).toBe(true);
    expect(decideChangelogEntry(fields({ title: "one", version: null })).ok).toBe(true);
});

test("a body or at least one non-empty list is the content", () => {
    expect(decideChangelogEntry(fields({ body: "" }))).toEqual(INVALID);
    expect(decideChangelogEntry(fields({ body: "", added: ["x"] })).ok).toBe(true);
    expect(decideChangelogEntry(fields({ body: "", changed: ["x"] })).ok).toBe(true);
    expect(decideChangelogEntry(fields({ body: "", fixed: ["x"] })).ok).toBe(true);
    expect(decideChangelogEntry(fields({ body: "text" })).ok).toBe(true);
});

test("an existing title-and-body row passes unchanged", () => {
    const existing = fields({ title: "as entries always were", body: "the body" });
    expect(decideChangelogEntry(existing)).toEqual(ok(existing));
});
