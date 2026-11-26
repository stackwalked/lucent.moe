import { type Action, ActionSchema } from "@lucent/policy/actions";

// Stored roles outlive the Action union: a permission dropped from code stays in old rows. It
// grants nothing and is kept apart so an admin can see and clean it up.
export function splitPermissions(stored: readonly string[]): {
    readonly known: readonly Action[];
    readonly unknown: readonly string[];
} {
    const known: Action[] = [];
    const unknown: string[] = [];
    for (const raw of stored) {
        const parsed = ActionSchema.safeParse(raw);
        if (parsed.success) {
            known.push(parsed.data);
        } else {
            unknown.push(raw);
        }
    }
    return { known, unknown };
}
