import { toIsoTimestamp } from "@lucent/core/clock";
import type { EpochMs } from "@lucent/core/scalars";

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
