export const PREFERENCES_TITLE = "notification preferences";
export const PREFERENCES_COPY = {
    security: "account security",
    required: "inbox and email always on",
    status: "product support changes",
    ticketReply: "support replies to your tickets",
    inbox: "inbox",
    mail: "email",
    discord: "discord message",
    discordUnlinked: "discord not linked.",
    linkDiscord: "link discord",
    save: "save",
    follows: "product subscriptions",
    follow: (name: string) => `follow ${name}`,
    unfollow: (name: string) => `unfollow ${name}`,
} as const;
