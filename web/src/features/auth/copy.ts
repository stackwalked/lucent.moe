export const RESET_COPY = {
    title: "reset your password",
    request: "request a link",
    email: "email",
    password: "new password",
    redeem: "change password",
    sent: "if this account can reset by email, a link is on its way.",
    changed: "password changed.",
    signIn: "sign in",
};
export const SIGN_IN_COPY = {
    title: "sign in",
    username: "username",
    password: "password",
    submit: "sign in",
    withPasskey: "sign in with a passkey",
    secondTitle: "one more step",
    usePasskey: "use your passkey",
    useCode: "use a code instead",
    code: "authenticator code",
    startOver: "start over",
    signInAgain: "sign in again",
    passkeyUnusable: "no passkey available in this browser.",
    triesLeft: (n: number) => (n === 1 ? "1 try left." : `${n} tries left.`),
} as const;

// Where a sign-in step changes what a refusal means.
export const SIGN_IN_REFUSALS = {
    code: {
        INVALID_CREDENTIALS: "wrong code.",
        FLOW_INVALID: "sign-in timed out or too many tries. start again.",
    },
    secondFactor: {
        FLOW_INVALID: "sign-in timed out or too many tries. start again.",
    },
} as const;
