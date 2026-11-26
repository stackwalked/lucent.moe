import { DOC_FILES } from "./files.ts";
import { scopesWithPages } from "./index.ts";

const SCOPES = scopesWithPages(DOC_FILES);

// Whether a scope (a product id) has pages: the product page's "docs" tab.
export function hasDocs(scope: string): boolean {
    return SCOPES.includes(scope);
}
