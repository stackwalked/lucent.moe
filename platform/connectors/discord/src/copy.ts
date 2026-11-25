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

export const STAFF_COPY = {
    whoCommand: "an account, for staff",
    whoMember: "a discord member",
    whoAccount: "a username or account id",
    whoNeither: "name a member, or a username or account id.",
    briefCommand: "the day so far, for staff",
    releasesCommand: "current releases, for staff",
    // One answer for every reason a staff read is refused: nobody learns which it was.
    refused: "you can't read that here.",
    notFound: "no account matches that.",
    whoHeading: (username: string | null, status: string) =>
        `**${username === null ? "no username yet" : plain(username)}** · ${status.replace("_", " ")}`,
    roles: (roles: readonly string[]) =>
        roles.length === 0 ? "no roles" : `roles: ${roles.map(plain).join(", ")}`,
    licences: (licences: readonly { readonly product: string; readonly until: number | null }[]) =>
        licences.length === 0
            ? "no licence"
            : `licences: ${licences
                  .map(
                      (l) =>
                          `${plain(l.product)} ${l.until === null ? "with no end" : `until ${when(l.until)}`}`,
                  )
                  .join(", ")}`,
    devices: (count: number, limit: number) => `pcs: ${count} of ${limit}`,
    lastSeen: (at: number | null) =>
        at === null ? "never signed in on the site" : `last on the site ${when(at)}`,
    lastSession: (session: { readonly at: number; readonly running: boolean } | null) =>
        session === null
            ? "no session yet"
            : `last session ${when(session.at)}${session.running ? ", running" : ""}`,
    inReview: "in review",
    discord: (userId: string) => `discord: <@${userId}>`,
    accountId: (id: string) => `\`${id}\``,
    openAccount: "account",
    brief: (b: {
        readonly sessionsRunning: number;
        readonly startsToday: number;
        readonly licencesActive: number;
        readonly licencesEnding: number;
        readonly reviewOpen: number;
        readonly ticketsOpen: number;
    }) =>
        [
            `sessions running: ${b.sessionsRunning}`,
            `starts in the last day: ${b.startsToday}`,
            `licences: ${b.licencesActive} running, ${b.licencesEnding} ending within a week`,
            `review: ${b.reviewOpen} open`,
            `tickets waiting on staff: ${b.ticketsOpen}`,
        ].join("\n"),
    openSystem: "system",
    noReleases: "no product has a channel.",
    release: (line: {
        readonly product: string;
        readonly channel: string;
        readonly current: { readonly number: string; readonly promotedAt: number } | null;
    }) =>
        line.current === null
            ? `**${plain(line.product)}** ${line.channel}: nothing promoted`
            : `**${plain(line.product)}** ${line.channel}: release ${line.current.number}, ${when(line.current.promotedAt)}`,
    openReleases: "releases",
} as const;

export const QUEUE_COPY = {
    ticket: (t: {
        readonly ticketKind: "help" | "appeal";
        readonly subject: string | null;
        readonly product: string | null;
        readonly username: string | null;
        readonly state: "open" | "answered" | "closed";
    }) => {
        const who = t.username === null ? "an account with no username" : plain(t.username);
        const what =
            t.ticketKind === "appeal"
                ? `appeal from ${who}`
                : `**${plain(t.subject ?? "")}** from ${who}`;
        const product = t.product === null ? "" : ` · ${plain(t.product)}`;
        const state =
            t.state === "open"
                ? "waiting on staff"
                : t.state === "answered"
                  ? "answered"
                  : "closed";
        return `ticket: ${what}${product} · ${state}`;
    },
    review: (r: {
        readonly username: string | null;
        readonly riskScore: number;
        readonly urgencyScore: number;
        readonly state: "open" | "decided";
        readonly outcome: "no_action" | "actioned" | null;
    }) => {
        const who = r.username === null ? "an account with no username" : plain(r.username);
        const state =
            r.state === "open"
                ? "open"
                : r.outcome === "actioned"
                  ? "closed, actioned"
                  : "closed, no action";
        return `review: ${who} · risk ${r.riskScore}, urgency ${r.urgencyScore} · ${state}`;
    },
    openTicket: "open ticket",
    openReview: "open review",
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
