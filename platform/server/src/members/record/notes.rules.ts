import { err, ok, type Result } from "@lucent/core/result";
import type { ProductId } from "@lucent/core/scalars";
import { LOADER_PRODUCT } from "../../delivery/releases/reads.ts";

// What a changelog entry must hold beyond the shape the contract bounds: a productId exactly
// when the subject is a product, a version or a title to be known by, and some content (a body,
// or at least one non-empty list). The table's checks mirror all three. An entry that names a
// release also needs a version, a subject that is the release's own (its product, or the loader
// for a loader release), and the release to be no other entry's.
export type ChangelogEntryFields = {
    readonly subject: "product" | "loader" | "service";
    readonly productId: ProductId | null;
    readonly version: string | null;
    readonly title: string | null;
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly fixed: readonly string[];
    readonly body: string;
    // Hex of the release's id.
    readonly releaseId: string | null;
};

// The named release as the writer found it under lock: null when there is no such release,
// else its product and the entry already holding it, if another one does.
export type NamedRelease = {
    readonly productId: string;
    readonly heldByOther: boolean;
} | null;

export type InvalidEntry = { readonly code: "INVALID_ENTRY" };

export function decideChangelogEntry(
    fields: ChangelogEntryFields,
    release: NamedRelease,
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
    if (fields.releaseId === null) return ok(fields);
    if (fields.version === null || release === null || release.heldByOther) {
        return err({ code: "INVALID_ENTRY" });
    }
    const matches =
        release.productId === LOADER_PRODUCT
            ? fields.subject === "loader"
            : fields.subject === "product" && fields.productId === release.productId;
    return matches ? ok(fields) : err({ code: "INVALID_ENTRY" });
}
