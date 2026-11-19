import { expect, test } from "bun:test";
import { codeDigits } from "../src/ui/CodeInput/digits.ts";
import { passwordHint, passwordLength, passwordProblem } from "../src/ui/NewPassword/length.ts";

test("a pasted code keeps its six digits and nothing else", () => {
    expect(codeDigits("123 456")).toBe("123456");
    expect(codeDigits("12-34-56-78")).toBe("123456");
    expect(codeDigits("abc")).toBe("");
});

test("the password length counts code points after NFKC, as the server does", () => {
    expect(passwordLength("😀😀")).toBe(2);
    expect(passwordLength("ﬁ")).toBe(2);
    expect(passwordLength("ｆｕｌｌ")).toBe(4);
});

test("a password is only a problem outside the limits, and empty is left to required", () => {
    expect(passwordProblem("")).toBeUndefined();
    expect(passwordProblem("a".repeat(11))).toBeDefined();
    expect(passwordProblem("a".repeat(12))).toBeUndefined();
    expect(passwordProblem("a".repeat(128))).toBeUndefined();
    expect(passwordProblem("a".repeat(129))).toBeDefined();
    expect(passwordProblem("😀".repeat(12))).toBeUndefined();
    expect(passwordHint(5)).not.toBe(passwordHint(12));
});
