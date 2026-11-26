import type { ComponentType } from "react";
import type { Meta } from "./index.ts";

// What an .mdx page exports: its body as a component and `meta` (title and order), which stands
// in for front matter so no remark plugin is needed.
export type DocModule = {
    readonly default: ComponentType<{ readonly components?: Record<string, ComponentType<never>> }>;
    readonly meta: Meta;
};
