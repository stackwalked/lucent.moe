export const DISCORD_RULES_TITLE = "discord";

export const DISCORD_RULES_COPY = {
    roles: "roles",
    rolesHint:
        "the bot gives each discord role to linked accounts that meet its rule, and takes it back when they stop. a role in no rule is never touched.",
    staffChannels: "staff channels",
    staffHint: "staff lookups are answered only in these channels.",
    feeds: "feeds",
    feedsHint:
        "what the bot posts to each channel. a feed starts with what happens after it is added.",
    role: "discord role id",
    channel: "discord channel id",
    idHint: "turn on developer mode in discord, then right-click and copy the id.",
    who: "given to",
    feed: "posts",
    added: "added",
    linked: "every linked account",
    entitled: (product: string) => `accounts entitled to ${product}`,
    holds: (role: string) => `accounts holding ${role}`,
    status: "product status changes",
    resources: "new resources",
    releases: "releases",
    add: "add",
    addRole: "add a role rule",
    addChannel: "add a staff channel",
    addFeed: "add a feed",
    remove: "remove",
    removeTitle: (id: string) => `remove the rule for ${id}`,
    removeBody:
        "the bot stops acting on it. roles it gave stay until staff remove them in discord.",
    noRoles: "no role rules yet.",
    noChannels: "no staff channels yet.",
    noFeeds: "no feeds yet.",
    unknown: "unknown",
} as const;
