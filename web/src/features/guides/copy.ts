export const GUIDES_COPY = {
    titleField: "title",
    bodyField: "guide",
    edit: "edit",
    save: "save",
    cancel: "cancel",
    back: "back to the product",
    by: (name: string | null) => `by ${name ?? "—"}`,
} as const;
