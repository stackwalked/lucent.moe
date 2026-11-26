// Modules the Vite plugins in dev/ provide.
declare module "virtual:lucent/tokens.css";

// An .mdx page: its body and the `meta` it exports in place of front matter.
declare module "*.mdx" {
    import type { DocModule } from "./features/docs/module.ts";

    const body: DocModule["default"];
    // biome-ignore lint/style/noDefaultExport: an .mdx module's body is its default export
    export default body;
    export const meta: DocModule["meta"];
}
