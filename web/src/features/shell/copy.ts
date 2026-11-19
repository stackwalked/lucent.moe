export const SHELL_COPY = {
    account: "account",
    signIn: "sign in",
    signOut: "sign out",
    menu: (username: string) => `signed in as ${username}`,
    graphite: "graphite",
    washi: "washi",
    systemTheme: "match system",
} as const;
