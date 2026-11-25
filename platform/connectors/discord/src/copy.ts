// Everything the bot says, in the site's voice (web/AGENTS.md): short, lowercase, second person,
// what happened and then what to do. Names someone typed (products, titles) keep their case.

// Discord markdown in a staff-typed title would otherwise change how the line reads.
function plain(text: string): string {
    return text.replace(/[\\*_`~|>[\]()#-]/g, (char) => `\\${char}`);
}

export const COMMANDS_COPY = {
    link: "link your lucent.moe account",
    linkCode: "the code from your account's discord page on lucent.moe",
    unlink: "unlink your lucent.moe account",
} as const;

export const REPLIES = {
    linked: "linked. your roles here now follow your lucent.moe account.",
    codeInvalid: (page: string) =>
        `that code doesn't work. codes last ten minutes and work once. get a new one at ${page}`,
    alreadyLinked:
        "this discord account or that lucent.moe account is already linked. unlink first.",
    unlinked: "unlinked. the roles your account gave you leave in a moment.",
    notLinked: "this discord account isn't linked.",
    unavailable: "lucent.moe can't be reached right now. try again in a moment.",
} as const;

export const FEEDS_COPY = {
    open: "open on lucent.moe",
    status: (product: string, state: "announced" | "live", supported: boolean | null) => {
        if (state === "announced") return `**${plain(product)}** is announced.`;
        if (supported === null) return `**${plain(product)}** is live.`;
        return supported
            ? `**${plain(product)}** is up.`
            : `**${plain(product)}** is down: a game update needs support first.`;
    },
    resource: (title: string, product: string | null) =>
        product === null
            ? `new resource: **${plain(title)}**`
            : `new resource for ${plain(product)}: **${plain(title)}**`,
    release: (product: string, channel: string, number: string) =>
        `**${plain(product)}** release ${number} is out on ${channel}.`,
} as const;
