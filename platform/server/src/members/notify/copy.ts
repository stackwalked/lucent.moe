import { toIsoTimestamp } from "@lucent/core/clock";
import type { EpochMs } from "@lucent/core/scalars";
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
        body: `finish setting up your account within 3 days:\n\n${link}\n\nnot you? ignore this email.`,
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

const MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

// The day in UTC, as the site writes dates: "2 december 2026".
export function utcDay(at: EpochMs): string {
    const [year = "", month = "", day = ""] = toIsoTimestamp(at).slice(0, 10).split("-");
    return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

// Sent when a member asks to delete their account; the link is where they keep it.
export function deletionPendingMail(params: { readonly dueAt: EpochMs; readonly link: string }) {
    return {
        subject: "your lucent account will be deleted",
        body: `your account will be deleted on ${utcDay(params.dueAt)}.\n\nto keep it, sign in before then and choose keep my account:\n\n${params.link}`,
    };
}
