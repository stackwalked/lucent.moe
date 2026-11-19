import { useLocation, useRouter } from "@tanstack/react-router";
import { type RefusalCode, refusalText } from "../../copy/refusals.ts";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Refusal } from "../../ui/Refusal/Refusal.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { forgetSession } from "../../viewer.ts";
import { signInAgain } from "../security/server.ts";
import { SIGN_IN_COPY } from "./copy.ts";

// Proving it's you again, for an account without a passkey: sign in, land back here.
function SignInAgain() {
    const router = useRouter();
    const { pathname } = useLocation();
    return (
        <Button
            size="sm"
            onClick={async () => {
                await signInAgain({ data: { returnTo: pathname } });
                forgetSession();
                await router.navigate({ to: "/sign-in" });
            }}
        >
            {SIGN_IN_COPY.signInAgain}
        </Button>
    );
}

// A server function's refusal, in words, above the button that caused it.
export function RefusalNote({
    refused,
    overrides,
    extra,
}: {
    readonly refused: Refused | null;
    readonly overrides?: { readonly [C in RefusalCode]?: string };
    readonly extra?: string;
}) {
    if (refused === null) return null;
    const text = refusalText(refused.code, overrides);
    const block = (
        <Refusal {...(refused.reference === null ? {} : { reference: refused.reference })}>
            {extra === undefined ? text : `${text} ${extra}`}
        </Refusal>
    );
    if (refused.code !== "REAUTH_REQUIRED") return block;
    return (
        <Stack gap={2}>
            {block}
            <div>
                <SignInAgain />
            </div>
        </Stack>
    );
}
