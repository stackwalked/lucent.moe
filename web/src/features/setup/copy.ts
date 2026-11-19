import { RULES_COPY } from "../../copy/rules.ts";

export const SETUP_COPY = {
    pageTitle: "set up",
    title: "set up your lucent.moe account",
    continue: "continue",
    signedInAs: (username: string) => `you're signed in as ${username}. continuing signs you out.`,
    noLink: "this setup link has expired or was already used. ask staff for a new one.",
    usernameTitle: "choose a username",
    username: "username",
    usernameRules: RULES_COPY.username,
    chooseUsername: "continue",
    methodTitle: "how you'll sign in",
    passkey: "passkey (recommended)",
    passwordAndApp: "password and authenticator app",
    doneTitle: "you're set up.",
    addAnother: "add another way to sign in",
    finish: "finish",
} as const;
