import type { DocModule } from "./module.ts";

// Which docs pages exist, from their paths alone: the glob keys cost nothing, the pages
// themselves load only when one is opened. Nothing lists a page by hand.
export const DOC_LOADERS = import.meta.glob<DocModule>("/content/docs/**/*.mdx");

export const DOC_FILES: readonly string[] = Object.keys(DOC_LOADERS);
