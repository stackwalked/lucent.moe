export const PREFERENCES_TITLE = "notification preferences";
export const PREFERENCES_COPY = {
    security: "account security",
    required: "you can’t turn off inbox or email for security notices.",
    status: "product support changes",
    inbox: "inbox",
    mail: "email",
    discord: "discord message",
    discordUnlinked: "discord messages need a linked discord account.",
    linkDiscord: "link discord",
    save: "save",
    follows: "product subscriptions",
    follow: (name: string) => `follow ${name}`,
    unfollow: (name: string) => `unfollow ${name}`,
} as const;
