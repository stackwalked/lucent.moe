import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { forgetSession } from "../../viewer.ts";
import { useStepUp } from "../step-up/StepUp.tsx";
import { PRIVACY_COPY } from "./copy.ts";
import { askAppealDeletion, askDeletion, keepAccount, keepAppealAccount } from "./server.ts";

type Answer = { readonly ok: true } | { readonly ok: false; readonly refused: Refused };

// Asking needs a recent proof. A member's page asks for the passkey through the step-up guard and
// sends it again; an appeal session can't step up, so it was its sign-in that proved a factor and
// a stale one means signing in again. The page reloads its data afterwards, so the date shown is
// the one platform set.
export function useDeletion(purpose: "member" | "appeal") {
    const router = useRouter();
    const guard = useStepUp();
    const ask = purpose === "member" ? () => guard(() => askDeletion()) : () => askAppealDeletion();
    const keep = purpose === "member" ? keepAccount : keepAppealAccount;
    const overrides = purpose === "appeal" ? { REAUTH_REQUIRED: PRIVACY_COPY.signInAgain } : {};
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);

    const settle = async (reply: Answer) => {
        setPending(false);
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) {
            setConfirming(false);
            // The shell's pending line reads the session, which is remembered until forgotten.
            forgetSession();
            await router.invalidate();
        }
    };

    return {
        confirming,
        pending,
        refused,
        overrides,
        open: () => setConfirming(true),
        close: () => {
            setConfirming(false);
            setRefused(null);
        },
        request: async () => {
            setPending(true);
            await settle(await ask());
        },
        keepIt: async () => {
            setPending(true);
            await settle(await keep());
        },
    };
}
