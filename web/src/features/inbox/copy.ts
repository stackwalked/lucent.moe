export const INBOX_TITLE = "inbox";
export const inboxLabel = (count: number | null) =>
    count === null ? INBOX_TITLE : `inbox (${count})`;
export const INBOX_COPY = {
    empty: "no notifications",
    security: "account security notice",
    product: (id: string) => `support changed for ${id}`,
    mark: "mark as read",
    read: "read",
    notification: "notification",
    time: "received",
    status: "status",
} as const;
