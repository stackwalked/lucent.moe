import { err, ok, type Result } from "@lucent/core/result";

// What a member does in a product's cloud pages. Whatever they already hold they can always list,
// read, delete and stop sharing, however the product's lifecycle or their entitlement stands;
// anything that adds to the store needs the product to be one they could start today.
export type CloudOperation =
    | "list"
    | "history"
    | "delete"
    | "revoke"
    | "create"
    | "rename"
    | "restore"
    | "share"
    | "import";

const NEEDS_CURRENT: Readonly<Record<CloudOperation, boolean>> = {
    list: false,
    history: false,
    delete: false,
    revoke: false,
    create: true,
    rename: true,
    restore: true,
    share: true,
    import: true,
};

// A product the member may neither start nor holds anything in is answered as one that doesn't
// exist, so a guessed id learns nothing.
export function decideCloudAccess(params: {
    readonly operation: CloudOperation;
    readonly eligible: boolean;
    readonly holdsItems: boolean;
}): Result<void, { readonly code: "NOT_FOUND" }> {
    const { operation, eligible, holdsItems } = params;
    const allowed = NEEDS_CURRENT[operation] ? eligible : eligible || holdsItems;
    return allowed ? ok(undefined) : err({ code: "NOT_FOUND" });
}
