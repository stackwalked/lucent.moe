// What the platform gateway throws when platform can't answer a page's loader, and the error
// boundary renders as the 503 page with its support reference.
export type Unavailable = { readonly unavailable: true; readonly reference: string };

export function isUnavailable(error: unknown): error is Unavailable {
    return typeof error === "object" && error !== null && "unavailable" in error;
}
