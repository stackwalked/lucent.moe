export const SIGN_IN_COPY = {
    title: "Sign in",
    username: "Username",
    password: "Password",
    submit: "Sign in",
    withPasskey: "Sign in with a passkey",
    secondTitle: "One more step",
    usePasskey: "Use your passkey",
    useCode: "Use a code instead",
    code: "Code",
    codeHint: "From your authenticator app",
    startOver: "Start over",
    signInAgain: "Sign in again",
    passkeyUnusable: "Your browser couldn't use a passkey here.",
    triesLeft: (n: number) => (n === 1 ? "1 try left." : `${n} tries left.`),
} as const;

// Where a sign-in step changes what a refusal means.
export const SIGN_IN_REFUSALS = {
    code: {
        INVALID_CREDENTIALS: "That code didn't work. Codes change every 30 seconds.",
        FLOW_INVALID: "This sign-in timed out or had too many tries. Start again.",
    },
    secondFactor: {
        FLOW_INVALID: "This sign-in timed out or had too many tries. Start again.",
    },
} as const;
