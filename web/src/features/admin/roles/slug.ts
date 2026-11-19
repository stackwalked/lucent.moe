import { RoleId } from "@lucent/core/scalars";

const PREFIX = "role_";
const SLUG_MAX = 48;

// A role's id comes from its name once, when the role is made: lowercase a–z, 0–9, "_" and "-",
// accents folded to their letters, anything else a separator, separators collapsed to one and
// trimmed from both ends. Null when fewer than two characters are left, which RoleId rejects.
export function roleIdFor(name: string): RoleId | null {
    const folded = name
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase();
    const slug = folded
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/[-_]*-[-_]*/g, "-")
        .replace(/_{2,}/g, "_")
        .replace(/^[-_]+|[-_]+$/g, "")
        .slice(0, SLUG_MAX)
        .replace(/[-_]+$/g, "");
    const parsed = RoleId.safeParse(`${PREFIX}${slug}`);
    return parsed.success ? parsed.data : null;
}
