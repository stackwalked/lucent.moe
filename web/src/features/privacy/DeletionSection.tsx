import type { DeletionStatus } from "@lucent/rpc/web/deletion";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { z } from "zod";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { forgetSession } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { useStepUp } from "../step-up/StepUp.tsx";
import { PRIVACY_COPY } from "./copy.ts";
import { askAppealDeletion, askDeletion, keepAccount, keepAppealAccount } from "./server.ts";

// Asking needs a recent proof. A member's page asks for the passkey through the step-up guard and
// sends it again; an appeal session can't step up, so it was its sign-in that proved a factor and
// a stale one means signing in again. The page reloads its data afterwards, so the date shown is
// the one platform set.
export function DeletionSection({
    status,
    purpose,
}: {
    readonly status: z.output<typeof DeletionStatus>;
    readonly purpose: "member" | "appeal";
}) {
    const router = useRouter();
    const guard = useStepUp();
    const ask = purpose === "member" ? () => guard(() => askDeletion()) : () => askAppealDeletion();
    const keep = purpose === "member" ? keepAccount : keepAppealAccount;
    const overrides = purpose === "appeal" ? { REAUTH_REQUIRED: PRIVACY_COPY.signInAgain } : {};
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);

    const settle = async (
        reply: { readonly ok: true } | { readonly ok: false; readonly refused: Refused },
    ) => {
        setPending(false);
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) {
            setConfirming(false);
            // The shell's pending line reads the session, which is remembered until forgotten.
            forgetSession();
            await router.invalidate();
        }
    };

    if (status.state === "pending") {
        return (
            <Section caption={PRIVACY_COPY.deletion}>
                <Stack gap={3}>
                    <p>
                        {PRIVACY_COPY.pending} <Time at={status.dueAt} />
                    </p>
                    <RefusalNote refused={refused} overrides={overrides} />
                    <div>
                        <Button
                            tone="pink"
                            pending={pending}
                            onClick={async () => {
                                setPending(true);
                                await settle(await keep());
                            }}
                        >
                            {PRIVACY_COPY.keep}
                        </Button>
                    </div>
                </Stack>
            </Section>
        );
    }
    return (
        <Section caption={PRIVACY_COPY.deletion}>
            <Stack gap={3}>
                <p>{PRIVACY_COPY.deletionBody}</p>
                <div>
                    <Button tone="danger" onClick={() => setConfirming(true)}>
                        {PRIVACY_COPY.deleteAccount}
                    </Button>
                </div>
            </Stack>
            <Dialog
                open={confirming}
                onClose={() => setConfirming(false)}
                title={PRIVACY_COPY.confirmTitle}
                busy={pending}
                actions={
                    <>
                        <Button tone="ghost" onClick={() => setConfirming(false)}>
                            {PRIVACY_COPY.cancel}
                        </Button>
                        <Button
                            tone="danger"
                            pending={pending}
                            onClick={async () => {
                                setPending(true);
                                await settle(await ask());
                            }}
                        >
                            {PRIVACY_COPY.deleteAccount}
                        </Button>
                    </>
                }
            >
                <Stack gap={3}>
                    <p>{PRIVACY_COPY.confirmBody}</p>
                    <RefusalNote refused={refused} overrides={overrides} />
                </Stack>
            </Dialog>
        </Section>
    );
}
