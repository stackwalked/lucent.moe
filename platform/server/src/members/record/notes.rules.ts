import { err, ok, type Result } from "@lucent/core/result";
import type { ProductId } from "@lucent/core/scalars";

// What a changelog entry must hold beyond the shape the contract bounds: a productId exactly
// when the subject is a product, a version or a title to be known by, and some content (a body,
// or at least one non-empty list). The table's checks mirror all three.
export type ChangelogEntryFields = {
    readonly subject: "product" | "loader" | "service";
    readonly productId: ProductId | null;
    readonly version: string | null;
    readonly title: string | null;
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly fixed: readonly string[];
    readonly body: string;
};

export type InvalidEntry = { readonly code: "INVALID_ENTRY" };

export function decideChangelogEntry(
    fields: ChangelogEntryFields,
): Result<ChangelogEntryFields, InvalidEntry> {
    if ((fields.productId !== null) !== (fields.subject === "product")) {
        return err({ code: "INVALID_ENTRY" });
    }
    if (fields.version === null && fields.title === null) return err({ code: "INVALID_ENTRY" });
    if (
        fields.body === "" &&
        fields.added.length === 0 &&
        fields.changed.length === 0 &&
        fields.fixed.length === 0
    ) {
        return err({ code: "INVALID_ENTRY" });
    }
    return ok(fields);
}
