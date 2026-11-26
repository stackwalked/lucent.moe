// A file's size as a reader thinks of it.
export function sizeText(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kb`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} mb`;
}
