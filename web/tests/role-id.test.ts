import { expect, test } from "bun:test";
import { roleIdFor } from "../src/features/admin/roles/slug.ts";

const idOf = (name: string): string | null => roleIdFor(name);

test("a name becomes a lowercase slug behind the role prefix", () => {
    expect(idOf("Moderator")).toBe("role_moderator");
    expect(idOf("Release Managers")).toBe("role_release-managers");
    expect(idOf("front_desk")).toBe("role_front_desk");
});

test("separators collapse and trim, whatever they were", () => {
    expect(idOf("  a   b  ")).toBe("role_a-b");
    expect(idOf("--a--b--")).toBe("role_a-b");
    expect(idOf("a - _ - b")).toBe("role_a-b");
    expect(idOf("a__b")).toBe("role_a_b");
    expect(idOf("__ab__")).toBe("role_ab");
});

test("accents fold to letters and other scripts count as separators", () => {
    expect(idOf("Café Crème")).toBe("role_cafe-creme");
    expect(idOf("ＡＢＣ")).toBe("role_abc");
    expect(idOf("管理者 ab")).toBe("role_ab");
});

test("under two characters left is no id", () => {
    expect(idOf("")).toBeNull();
    expect(idOf("   ")).toBeNull();
    expect(idOf("a")).toBeNull();
    expect(idOf("!a!")).toBeNull();
    expect(idOf("管理者")).toBeNull();
    expect(idOf("ab")).toBe("role_ab");
});

test("a long name is cut to 48 characters without a trailing separator", () => {
    expect(idOf("a".repeat(100))).toBe(`role_${"a".repeat(48)}`);
    expect(idOf(`${"a".repeat(47)} bbbb`)).toBe(`role_${"a".repeat(47)}`);
});

test("hostile input never leaves the id alphabet", () => {
    for (const name of [
        "../../etc",
        "a\u0000b",
        "role_x'; drop--",
        "<script>x</script>",
        "a\nb",
        "a.b",
    ]) {
        const id = idOf(name);
        expect(id === null || /^role_[a-z0-9_-]{2,48}$/.test(id)).toBe(true);
    }
    expect(idOf("../../etc")).toBe("role_etc");
    expect(idOf("a\u0000b")).toBe("role_a-b");
});
