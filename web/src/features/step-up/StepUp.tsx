import { systemClock } from "@lucent/core/clock";
import { invariant } from "@lucent/core/contain";
import type { EpochMs } from "@lucent/core/scalars";
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { forgetSession } from "../../viewer.ts";
import { assertPasskey } from "../../webauthn.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { beginStepUp, finishStepUp } from "../credentials/server.ts";
import { STEP_UP_COPY } from "./copy.ts";

// An action refused for want of a recent proof (STEP_UP_REQUIRED for staff actions,
// REAUTH_REQUIRED for credential changes) asks for the passkey once and is sent again, the same
// call with the same operationId, so it can't happen twice. Cancelling leaves it undone. Without a
// passkey the refusal stands: NO_PASSKEY, which the caller shows (a credential change then sends
// the member to sign in again).

type Guard = <T>(run: () => Promise<Outcome<T>>) => Promise<Outcome<T>>;
type Ask = () => Promise<Refused | "confirmed" | "cancelled">;
type Asked = { readonly resolve: (confirmed: Refused | "confirmed" | "cancelled") => void };

type StepUp = {
    readonly guard: Guard;
    readonly ask: Ask;
    // When this page last proved a passkey. The session the router holds says so only once it's
    // resolved again, and an action refused for another reason after a proof would ask twice.
    readonly provenAt: () => EpochMs | null;
};

const StepUpContext = createContext<StepUp | null>(null);

const NEEDS_PROOF = new Set(["STEP_UP_REQUIRED", "REAUTH_REQUIRED"]);

export function StepUpProvider({ children }: { readonly children: ReactNode }) {
    const [asked, setAsked] = useState<Asked | null>(null);
    const [pending, setPending] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    const latest = useRef<Asked | null>(null);
    const proven = useRef<EpochMs | null>(null);
    const provenAt = useCallback(() => proven.current, []);

    const ask = useCallback(
        () =>
            new Promise<Refused | "confirmed" | "cancelled">((resolve) => {
                const next = { resolve };
                latest.current = next;
                setRefused(null);
                setAsked(next);
            }),
        [],
    );

    const answer = (result: Refused | "confirmed" | "cancelled") => {
        latest.current?.resolve(result);
        latest.current = null;
        setAsked(null);
    };

    const confirm = async () => {
        setPending(true);
        setRefused(null);
        const begun = await beginStepUp();
        if (!begun.ok) {
            setPending(false);
            return answer(begun.refused);
        }
        const asserted = await assertPasskey({ options: begun.value });
        if (!asserted.ok) {
            setPending(false);
            if (asserted.error === "failed")
                setRefused({ code: "PASSKEY_REJECTED", reference: null });
            return;
        }
        const finished = await finishStepUp({ data: { response: asserted.value } });
        setPending(false);
        if (!finished.ok) return setRefused(finished.refused);
        forgetSession();
        proven.current = systemClock.now();
        answer("confirmed");
    };

    const guard: Guard = useCallback(
        async (run) => {
            const first = await run();
            if (first.ok || !NEEDS_PROOF.has(first.refused.code)) return first;
            const proof = await ask();
            if (proof === "cancelled") return first;
            if (proof === "confirmed") return await run();
            // No passkey to confirm with: a credential change stays REAUTH_REQUIRED (sign in
            // again); a staff action says it needs a passkey.
            const stays = proof.code === "NO_PASSKEY" && first.refused.code === "REAUTH_REQUIRED";
            return { ok: false, refused: stays ? first.refused : proof };
        },
        [ask],
    );

    return (
        <StepUpContext value={{ guard, ask, provenAt }}>
            {children}
            <Dialog
                open={asked !== null}
                onClose={() => answer("cancelled")}
                title={STEP_UP_COPY.title}
                actions={
                    <>
                        <Button tone="ghost" onClick={() => answer("cancelled")}>
                            {STEP_UP_COPY.cancel}
                        </Button>
                        <Button
                            tone="pink"
                            icon="key-round"
                            pending={pending}
                            onClick={() => void confirm()}
                        >
                            {STEP_UP_COPY.confirm}
                        </Button>
                    </>
                }
            >
                <Stack gap={3}>
                    <p>{STEP_UP_COPY.body}</p>
                    <RefusalNote refused={refused} />
                </Stack>
            </Dialog>
        </StepUpContext>
    );
}

export function useStepUp(): Guard {
    const context = useContext(StepUpContext);
    invariant(context !== null, "useStepUp needs a StepUpProvider above it");
    return context.guard;
}

// Asking before anything is sent, for an action known to need a recent step-up.
export function useStepUpPrompt(): Pick<StepUp, "ask" | "provenAt"> {
    const context = useContext(StepUpContext);
    invariant(context !== null, "useStepUpPrompt needs a StepUpProvider above it");
    return context;
}
