// The catalog writes names as products are known ("Counter-Strike 2"); pages show every word in
// lowercase, the names of things included.
export function productName(name: string): string {
    return name.toLowerCase();
}

// Staff pages hold product ids; they show them as members see them, through the public catalog.
// An id the catalog doesn't list (retired, or the catalog refused) shows as itself.
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
