import { expect, test } from "bun:test";
import {
    buildScopes,
    type Meta,
    neighbours,
    parseDocPath,
    scopesWithPages,
} from "../src/features/docs/index.ts";

const f = (scope: string, section: string, page: string) =>
    `/content/docs/${scope}/${section}/${page}.mdx`;

test.each([
    [
        "a page",
        "/content/docs/cs2/start/first-launch.mdx",
        { scope: "cs2", section: "start", page: "first-launch" },
    ],
    ["too deep", "/content/docs/cs2/a/b/c.mdx", null],
    ["too shallow", "/content/docs/cs2/readme.mdx", null],
    ["not mdx", "/content/docs/cs2/start/page.md", null],
    ["upper case", "/content/docs/CS2/start/page.mdx", null],
    ["sections file", "/content/docs/cs2/sections.ts", null],
] as const)("a docs path: %s", (_name, path, expected) => {
    expect(parseDocPath(path)).toEqual(expected);
});

test("scopes with pages are the scopes of the page files, sorted, and none for no files", () => {
    expect(
        scopesWithPages([f("lucent", "a", "x"), f("cs2", "a", "y"), f("cs2", "b", "z")]),
    ).toEqual(["cs2", "lucent"]);
    expect(scopesWithPages([])).toEqual([]);
    expect(buildScopes({ files: [], metas: {}, sections: {} })).toEqual([]);
});

const metas: Record<string, Meta> = {
    [f("cs2", "start", "second")]: { title: "second", order: 2 },
    [f("cs2", "start", "first")]: { title: "first", order: 1 },
    [f("cs2", "features", "aim")]: { title: "aim", order: 1 },
    [f("cs2", "extra", "tie-b")]: { title: "b", order: 1 },
    [f("cs2", "extra", "tie-a")]: { title: "a", order: 1 },
};

test("sections follow sections.ts, unlisted ones come after by id, pages by order then title", () => {
    const [scope] = buildScopes({
        files: Object.keys(metas),
        metas,
        sections: {
            cs2: [
                { id: "start", label: "start here" },
                { id: "features", label: "features" },
            ],
        },
    });
    expect(scope?.sections.map((s) => [s.id, s.label])).toEqual([
        ["start", "start here"],
        ["features", "features"],
        ["extra", "extra"],
    ]);
    expect(scope?.pages.map((p) => p.page)).toEqual(["first", "second", "aim", "tie-a", "tie-b"]);
});

test("previous and next walk the reading order across sections, and end at null", () => {
    const [scope] = buildScopes({
        files: Object.keys(metas),
        metas,
        sections: {
            cs2: [
                { id: "start", label: "start" },
                { id: "features", label: "features" },
            ],
        },
    });
    expect(scope).toBeDefined();
    if (scope === undefined) return;
    expect(neighbours(scope, { section: "start", page: "first" })).toEqual({
        previous: null,
        next: expect.objectContaining({ page: "second" }),
    });
    expect(neighbours(scope, { section: "features", page: "aim" })).toEqual({
        previous: expect.objectContaining({ page: "second" }),
        next: expect.objectContaining({ page: "tie-a" }),
    });
    expect(neighbours(scope, { section: "extra", page: "tie-b" }).next).toBeNull();
    expect(neighbours(scope, { section: "x", page: "y" })).toEqual({ previous: null, next: null });
});

test("a file with no meta is left out of the contents", () => {
    const scopes = buildScopes({
        files: [f("cs2", "a", "x"), f("cs2", "a", "y")],
        metas: { [f("cs2", "a", "x")]: { title: "x", order: 1 } },
        sections: {},
    });
    expect(scopes[0]?.pages.map((p) => p.page)).toEqual(["x"]);
});
