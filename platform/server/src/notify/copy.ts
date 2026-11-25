import type { Notice } from "@lucent/rpc/web/inbox";

export function passwordResetMail(link: string) {
    return {
        subject: "reset your lucent password",
        body: `use this link within 15 minutes to change your password. you will still need your enrolled sign-in factor.\n\n${link}\n\nif you did not request this, ignore this email.`,
    };
}

// For an account made from an invite or an application; staff hand over the links they make.
export function setupLinkMail(link: string) {
    return {
        subject: "set up your lucent account",
        body: `an account was made for this address. use this link within 3 days to choose a username and how you sign in:\n\n${link}\n\nif you did not ask for an account, ignore this email.`,
    };
}

// Says that support replied and where to read it; the reply and the subject stay on the site.
export function ticketReplyMail(link: string) {
    return {
        subject: "support replied to your ticket",
        body: `support replied to a ticket you opened. sign in to read it:\n\n${link}`,
    };
}

// The mail can arrive after access changes, so it must not name a now-hidden product.
export function notificationMail(notice: Exclude<Notice, { kind: "ticket_reply" }>) {
    if (notice.kind === "security") {
        return {
            subject: "account security notice",
            body: "there is a security notice for your lucent account. sign in to review it.",
        };
    }
    return {
        subject: "product support update",
        body: "support has changed for a product you follow. sign in to check its current status.",
    };
}
