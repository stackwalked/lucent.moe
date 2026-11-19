import { expect, test } from "bun:test";
import { shortenIdent } from "../src/ui/Ident/shorten.ts";

test("a long id keeps its prefix and its end", () => {
    expect(shortenIdent("acc_0123456789abcdefghijkl")).toBe("acc_0123…ijkl");
});

test("an id that would not get shorter is left whole", () => {
    expect(shortenIdent("ses_abcdefg")).toBe("ses_abcdefg");
    expect(shortenIdent("0123456789012")).toBe("0123456789012");
    expect(shortenIdent("01234567890123")).toBe("01234567…0123");
});
