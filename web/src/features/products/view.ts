// The catalog writes names as products are known ("Counter-Strike 2"); pages show every word in
// lowercase, the names of things included.
export function productName(name: string): string {
    return name.toLowerCase();
}
