// The file itself, as an attachment: a plain GET the list's button submits, streamed from
// platform through web.
export function downloadPath(resourceId: string): string {
    return `/resources/${resourceId}/download`;
}
