export const INBOX_TITLE = "inbox";
export const inboxLabel = (count: number | null) =>
    count === null || count === 0 ? INBOX_TITLE : `inbox (${count})`;
export const INBOX_COPY = {
    empty: "no notifications",
    security: "account security notice",
    product: (id: string) => `support changed for ${id}`,
    ticketReply: "support replied to your ticket",
    mark: "mark as read",
    read: "read",
} as const;
