export const RESET_COPY = {
    title: "reset your password",
    request: "request a link",
    email: "email",
    password: "new password",
    redeem: "change password",
    sent: "if your account can use email reset, check your email. staff accounts use staff recovery.",
    changed: "your password has changed. sign in with your enrolled factor.",
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
    code: "code",
    codeHint: "from your authenticator app",
    startOver: "start over",
    signInAgain: "sign in again",
    passkeyUnusable: "your browser couldn't use a passkey here.",
    triesLeft: (n: number) => (n === 1 ? "1 try left." : `${n} tries left.`),
} as const;

// Where a sign-in step changes what a refusal means.
export const SIGN_IN_REFUSALS = {
    code: {
        INVALID_CREDENTIALS: "that code didn't work. codes change every 30 seconds.",
        FLOW_INVALID: "this sign-in timed out or had too many tries. start again.",
    },
    secondFactor: {
        FLOW_INVALID: "this sign-in timed out or had too many tries. start again.",
    },
} as const;
