import { expect, test } from "bun:test";
import { safeReturnTo } from "../src/return-to.ts";

const ORIGIN = "https://lucent.moe";
const PAGES = [
    "/",
    "/account/security",
    "/admin/accounts",
    "/admin/accounts/$accountId",
    "/sign-in",
    "/setup",
];

test("a hostile returnTo lands on the home page", () => {
    for (const raw of [
        undefined,
        "",
        "//evil.test",
        "/\\evil.test",
        "https://evil.test/account/security",
        "evil.test",
        "/%2F%2Fevil.test",
        "/\t/evil.test",
        "javascript:alert(1)",
        "/sign-in",
        "/setup",
        "/setup/abc",
        "/nope",
        "/account/security/extra",
    ]) {
        expect({ raw, to: safeReturnTo(raw, ORIGIN, PAGES) }).toEqual({ raw, to: "/" });
    }
});

test("a page of ours comes back as it was, with its one ?q= and nothing else", () => {
    expect(safeReturnTo("/account/security", ORIGIN, PAGES)).toBe("/account/security");
    expect(safeReturnTo("/admin/accounts/acc_x", ORIGIN, PAGES)).toBe("/admin/accounts/acc_x");
    expect(safeReturnTo("/admin/accounts?q=status:suspended&x=1", ORIGIN, PAGES)).toBe(
        "/admin/accounts?q=status%3Asuspended",
    );
});
