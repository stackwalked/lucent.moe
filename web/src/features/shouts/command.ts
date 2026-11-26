export type PurgeTarget = { readonly username: string } | { readonly last: number };

// What the shout input holds once sent: a shout, a purge to confirm, or a purge typed wrongly.
export type ShoutInput =
    | { readonly kind: "post"; readonly body: string }
    | { readonly kind: "purge"; readonly target: PurgeTarget }
    | { readonly kind: "usage" };

const PURGE = /^\/purge(?:\s+(.*))?$/s;
const COUNT = /^\d+$/;
const USERNAME = /^[A-Za-z0-9_]{1,64}$/;
const MOST = 100;

// Staff type `/purge <username>` or `/purge <n>` (1 to 100) where others write a shout; for
// anyone else the same text is just a shout. A purge that does not fit either shape is usage,
// never posted, so a typo cannot publish a command.
export function readShoutInput(text: string, who: "staff" | "member"): ShoutInput {
    if (who !== "staff") return { kind: "post", body: text };
    const match = PURGE.exec(text.trim());
    if (match === null) return { kind: "post", body: text };
    const argument = (match[1] ?? "").trim();
    if (COUNT.test(argument)) {
        const last = Number(argument);
        return last >= 1 && last <= MOST ? { kind: "purge", target: { last } } : { kind: "usage" };
    }
    if (USERNAME.test(argument)) {
        return { kind: "purge", target: { username: argument.toLowerCase() } };
    }
    return { kind: "usage" };
}
