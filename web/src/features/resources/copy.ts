export const RESOURCES_TITLE = "resources";

export const RESOURCES_COPY = {
    none: "no files",
    title: "file",
    product: "product",
    everyone: "all members",
    size: "size",
    updated: "updated",
    download: "download",
    downloadTitle: (title: string) => `download ${title}`,
} as const;

// A file's size as a reader thinks of it.
export function sizeText(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kb`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} mb`;
}
