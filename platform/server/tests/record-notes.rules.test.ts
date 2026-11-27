import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import { ProductId } from "@lucent/core/scalars";
import {
    type ChangelogEntryFields,
    decideChangelogEntry,
    type NamedRelease,
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
        releaseId: null,
        ...over,
    };
}

const INVALID = err({ code: "INVALID_ENTRY" });

test("a productId exactly when the subject is a product", () => {
    expect(decideChangelogEntry(fields({}), null)).toEqual(ok(fields({})));
    expect(decideChangelogEntry(fields({ subject: "product", productId: null }), null)).toEqual(
        INVALID,
    );
    expect(decideChangelogEntry(fields({ subject: "product", productId: CS2 }), null).ok).toBe(
        true,
    );
    expect(decideChangelogEntry(fields({ subject: "loader", productId: CS2 }), null)).toEqual(
        INVALID,
    );
    expect(decideChangelogEntry(fields({ subject: "service", productId: CS2 }), null)).toEqual(
        INVALID,
    );
});

test("a version or a title names the entry", () => {
    expect(decideChangelogEntry(fields({ title: null, version: null }), null)).toEqual(INVALID);
    expect(decideChangelogEntry(fields({ title: null, version: "0.8.3" }), null).ok).toBe(true);
    expect(decideChangelogEntry(fields({ title: "one", version: null }), null).ok).toBe(true);
});

test("a body or at least one non-empty list is the content", () => {
    expect(decideChangelogEntry(fields({ body: "" }), null)).toEqual(INVALID);
    expect(decideChangelogEntry(fields({ body: "", added: ["x"] }), null).ok).toBe(true);
    expect(decideChangelogEntry(fields({ body: "", changed: ["x"] }), null).ok).toBe(true);
    expect(decideChangelogEntry(fields({ body: "", fixed: ["x"] }), null).ok).toBe(true);
    expect(decideChangelogEntry(fields({ body: "text" }), null).ok).toBe(true);
});

test("an existing title-and-body row passes unchanged", () => {
    const existing = fields({ title: "as entries always were", body: "the body" });
    expect(decideChangelogEntry(existing, null)).toEqual(ok(existing));
});

const RELEASE = "0a".repeat(16);
const free = (productId: string): NamedRelease => ({ productId, heldByOther: false });

test("an entry naming a release needs a version", () => {
    const named = { subject: "loader", releaseId: RELEASE } as const;
    expect(
        decideChangelogEntry(fields({ ...named, version: null }), free("lucent-loader")),
    ).toEqual(INVALID);
    expect(
        decideChangelogEntry(fields({ ...named, version: "0.1.0" }), free("lucent-loader")).ok,
    ).toBe(true);
});

test("an entry naming a release has that release's subject: its product, or the loader", () => {
    const named = { releaseId: RELEASE, version: "0.8.3" };
    const cs2Entry = fields({ ...named, subject: "product", productId: CS2 });
    expect(decideChangelogEntry(cs2Entry, free("cs2")).ok).toBe(true);
    expect(decideChangelogEntry(cs2Entry, free("other"))).toEqual(INVALID);
    expect(decideChangelogEntry(cs2Entry, free("lucent-loader"))).toEqual(INVALID);
    expect(
        decideChangelogEntry(fields({ ...named, subject: "loader" }), free("lucent-loader")).ok,
    ).toBe(true);
    expect(decideChangelogEntry(fields({ ...named, subject: "loader" }), free("cs2"))).toEqual(
        INVALID,
    );
    expect(decideChangelogEntry(fields({ ...named, subject: "service" }), free("cs2"))).toEqual(
        INVALID,
    );
});

test("an entry cannot name a release another entry names, or one that does not exist", () => {
    const entry = fields({ releaseId: RELEASE, version: "0.1.0", subject: "loader" });
    expect(decideChangelogEntry(entry, { productId: "lucent-loader", heldByOther: true })).toEqual(
        INVALID,
    );
    expect(decideChangelogEntry(entry, null)).toEqual(INVALID);
});
