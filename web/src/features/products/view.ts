import { PRODUCTS_COPY } from "./copy.ts";

// The loader is in the catalog so it can be granted, but it is not a product: no product page,
// no row in the picker, no place in /products.
export const LOADER_PRODUCT_ID = "lucent-loader";

// The catalog writes names as products are known ("Counter-Strike 2"); pages show every word in
// lowercase, the names of things included.
export function productName(name: string): string {
    return name.toLowerCase();
}

// Staff pages hold product ids; they show them as members see them, through the public catalog.
// An id the catalog doesn't list (retired, or the catalog refuses) shows as itself.
export function productNamer(
    catalog:
        | { readonly ok: true; readonly value: readonly { id: string; name: string }[] }
        | {
              readonly ok: false;
          },
): (productId: string) => string {
    const names = new Map(catalog.ok ? catalog.value.map((p) => [p.id, productName(p.name)]) : []);
    return (productId) => names.get(productId) ?? productId;
}

export type StatusWord = {
    readonly word: string;
    readonly tone: "ok" | "wait" | "shu" | "dim";
};

// The one word a product's state comes down to: supported when it runs today, updating while a
// game update is still open, stopped once retired, and before any of those the lifecycle word.
type LifecycleState = keyof typeof PRODUCTS_COPY.lifecycle;

// Null for a live product with nothing promoted yet: there is nothing to say, and "live" is
// no status at all.
export function statusWord(state: LifecycleState, supported: boolean | null): StatusWord | null {
    if (supported === true) return { word: PRODUCTS_COPY.supported, tone: "ok" };
    if (supported === false) return { word: PRODUCTS_COPY.updating, tone: "wait" };
    if (state === "retired") return { word: PRODUCTS_COPY.stopped, tone: "shu" };
    if (state === "live") return null;
    return { word: PRODUCTS_COPY.lifecycle[state], tone: "dim" };
}
