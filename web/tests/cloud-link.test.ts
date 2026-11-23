import { expect, test } from "bun:test";
import { consumeShareFragment } from "../src/features/cloud/link.ts";

test("only a fragment yields an invitation and the replacement address contains neither bearer nor query", () => {
    const token = "a".repeat(43);
    for (const [suffix, clean, result] of [
        [`?q=x#cs2/${token}`, "/share", { productId: "cs2", token }],
        [`#cs2/${token}/more`, "/share", null],
        [`#${token}`, "/share", null],
        [`?token=${token}`, null, null],
    ] as const) {
        const replaced: string[] = [];
        expect(
            consumeShareFragment(new URL(`https://test.invalid/share${suffix}`), (path) =>
                replaced.push(path),
            ),
        ).toEqual(result);
        expect(replaced).toEqual(clean === null ? [] : [clean]);
    }
});
