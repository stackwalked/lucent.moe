import { DOC_FILES } from "./files.ts";
import { buildScopes, type Meta, type Section } from "./index.ts";

// The contents, which needs each page's `meta`: imported by name and eagerly, so only the docs
// pages (not the bar) load it, and a page's body is left to its own lazy chunk.
const METAS = import.meta.glob<Meta>("/content/docs/**/*.mdx", { eager: true, import: "meta" });
const SECTIONS = import.meta.glob<readonly Section[]>("/content/docs/*/sections.ts", {
    eager: true,
    import: "default",
});

export const DOCS = buildScopes({
    files: DOC_FILES,
    metas: METAS,
    sections: Object.fromEntries(
        Object.entries(SECTIONS).flatMap(([path, sections]) => {
            const scope = /^\/content\/docs\/([^/]+)\/sections\.ts$/.exec(path)?.[1];
            return scope === undefined ? [] : [[scope, sections]];
        }),
    ),
});
