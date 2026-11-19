import { expect, test } from "bun:test";
import { lintModuleCss } from "../dev/css-lint.ts";

function lint(body: string, layer = "components"): readonly string[] {
    return lintModuleCss("x.module.css", `@layer ${layer} {\n${body}\n}\n`);
}

test("module CSS built from tokens passes", () => {
    expect(
        lint(`.a { color: var(--ink); padding: var(--s-2); border: 1px solid var(--line); --_gap: var(--s-1); gap: var(--_gap); }
.a:disabled { color: var(--ink-3); }
@media (max-width: 640px) { .a { inline-size: 100%; } }`),
    ).toEqual([]);
});

test("a raw color or an off-scale size is refused", () => {
    for (const body of [
        ".a { color: #fff; }",
        ".a { color: rgb(0 0 0); }",
        ".a { background: color-mix(in oklab, var(--ink) 4%, transparent); }",
        ".a { color: white; }",
        ".a { padding: 12px; }",
    ]) {
        expect({ body, problems: lint(body).length }).toEqual({ body, problems: 1 });
    }
});

test("ink-3 colors only an inert control", () => {
    expect(lint(".a { color: var(--ink-3); }")).toHaveLength(1);
    expect(lint('.a[aria-disabled="true"] { color: var(--ink-3); }')).toEqual([]);
});

test("a token that doesn't exist, !important, or a rule outside the layer is refused", () => {
    expect(lint(".a { color: var(--accent); }")).toHaveLength(1);
    expect(lint(".a { color: var(--ink) !important; }")).toHaveLength(1);
    expect(lintModuleCss("x.module.css", ".a { color: var(--ink); }\n")).toHaveLength(1);
    expect(lint(".a { color: var(--ink); }", "overrides")).toHaveLength(1);
    expect(
        lintModuleCss(
            "x.module.css",
            "@layer components {\n.a { color: var(--ink); }\n}\n.b { color: var(--ink); }\n",
        ),
    ).toHaveLength(1);
});
