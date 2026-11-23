import type { Notice } from "@lucent/rpc/web/inbox";

export function passwordResetMail(link: string) {
    return {
        subject: "reset your lucent password",
        body: `use this link within 15 minutes to change your password. you will still need your enrolled sign-in factor.\n\n${link}\n\nif you did not request this, ignore this email.`,
    };
}

// The mail can arrive after access changes, so it must not name a now-hidden product.
export function notificationMail(notice: Notice) {
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
