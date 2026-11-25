// Everything the bot says, in the site's voice (web/AGENTS.md): short, lowercase, second person,
// what happened and then what to do. Names someone typed (products, titles) keep their case.

// Discord markdown in a staff-typed title would otherwise change how the line reads.
function plain(text: string): string {
    return text.replace(/[\\*_`~|>[\]()#-]/g, (char) => `\\${char}`);
}

// Discord shows this in each reader's own time zone and language.
function when(at: number): string {
    return `<t:${Math.floor(at / 1_000)}:f>`;
}

export const COMMANDS_COPY = {
    link: "link your lucent.moe account",
    linkCode: "the code from your account's discord page on lucent.moe",
    unlink: "unlink your lucent.moe account",
    me: "your lucent.moe account: products, devices and standing",
    status: "how lucent.moe's products are doing",
    ticket: "ask lucent.moe staff for help",
} as const;

export const REPLIES = {
    linked: "linked. your roles here now follow your lucent.moe account.",
    codeInvalid: (page: string) =>
        `that code doesn't work. codes last ten minutes and work once. get a new one at ${page}`,
    alreadyLinked:
        "this discord account or that lucent.moe account is already linked. unlink first.",
    unlinked: "unlinked. the roles your account gave you leave in a moment.",
    notLinked: "this discord account isn't linked.",
    // The same words whether or not any account exists: nothing is said about one.
    linkFirst: (page: string) =>
        `this discord account isn't linked to lucent.moe. link it at ${page}`,
    suspended: (site: string) =>
        `your lucent.moe account is suspended. sign in at ${site} to see why and to appeal.`,
    locked: (site: string) => `your lucent.moe account can't be used right now. see ${site}`,
    unavailable: "lucent.moe can't be reached right now. try again in a moment.",
} as const;

type MeProduct = {
    readonly name: string;
    readonly state: "announced" | "seed" | "live" | "retired";
    readonly features: "*" | readonly string[];
    readonly channels: readonly {
        readonly channel: string;
        readonly release: { readonly supported: boolean } | null;
    }[];
};

function channelLine(channel: MeProduct["channels"][number]): string {
    if (channel.release === null) return `${channel.channel}: nothing released yet`;
    return channel.release.supported
        ? `${channel.channel}: up`
        : `${channel.channel}: waiting on support for a game update`;
}

function productLine(product: MeProduct): string {
    const state = product.state === "live" ? "" : ` (${product.state})`;
    const channels =
        product.channels.length === 0
            ? "no channel to run"
            : product.channels.map(channelLine).join(", ");
    const features =
        product.features === "*" || product.features.length === 0
            ? ""
            : `. features: ${product.features.join(", ")}`;
    return `**${plain(product.name)}**${state}: ${channels}${features}`;
}

export const ME_COPY = {
    heading: "your lucent.moe account",
    noProducts: "no products on this account.",
    product: productLine,
    devices: (count: number, limit: number) => `pcs: ${count} of ${limit}`,
    nextExpiry: (at: number | null) =>
        at === null ? "no licence of yours ends." : `your next licence ends ${when(at)}.`,
    // As the privacy page words them.
    restriction: (kind: "muted" | "barred", product: string | null, endsAt: number | null) => {
        const what =
            kind === "muted" ? "muted: you can't comment or shout" : "barred: you can't post";
        const where = product === null ? "everywhere" : `in ${plain(product)}`;
        const until = endsAt === null ? "until staff lift it" : `until ${when(endsAt)}`;
        return `${what} ${where} ${until}.`;
    },
    page: "open on lucent.moe",
} as const;

export const STATUS_COPY = {
    none: "nothing to report yet.",
} as const;

export const TICKET_COPY = {
    title: "ask staff for help",
    product: "product",
    noProduct: "no product",
    subject: "subject",
    body: "what happened",
    opened: "your ticket is open. staff answer on lucent.moe, where you can follow it.",
    open: "open ticket",
    // Discord holds the form to its lengths; only blank text gets this far.
    empty: "the subject and what happened can't be blank. open the form again.",
    unknownProduct: "that product isn't one your account can see. open the form again.",
    limit: "you have too many open tickets, or opened many today. close one on lucent.moe first.",
} as const;

export const DM_COPY = {
    security: "there's a new security notice on your lucent.moe account.",
    productStatus: (product: string) => `support for **${plain(product)}** changed.`,
    open: "open inbox",
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
