// The catalog writes names as products are known ("Counter-Strike 2"); pages show every word in
// lowercase, the names of things included.
export function productName(name: string): string {
    return name.toLowerCase();
}

// The products page lists what a member runs in a game; the loader has its own download page.
export function isGameProduct(product: { readonly kind: string }): boolean {
    return product.kind === "module";
}
