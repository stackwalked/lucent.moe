import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { deviceLabel } from "../../user-agent.ts";
import { createPasskey } from "../../webauthn.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { useStepUp } from "../step-up/StepUp.tsx";
import { CREDENTIALS_COPY } from "./copy.ts";
import { beginPasskeyRegistration, finishPasskeyRegistration } from "./server.ts";

// One browser prompt; the passkey is named for the browser and system it was made on, renamed
// later if wanted.
export function AddPasskey({ onAdded }: { readonly onAdded: () => void }) {
    const guard = useStepUp();
    const [pending, setPending] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);

    const add = async () => {
        setPending(true);
        setRefused(null);
        const begun = await guard(() => beginPasskeyRegistration());
        if (!begun.ok) {
            setPending(false);
            return setRefused(begun.refused);
        }
        const made = await createPasskey(begun.value);
        if (!made.ok) {
            setPending(false);
            if (made.error === "failed") setRefused({ code: "PASSKEY_REJECTED", reference: null });
            return;
        }
        const label = deviceLabel(navigator.userAgent, CREDENTIALS_COPY.unknownDevice);
        const finished = await finishPasskeyRegistration({ data: { label, response: made.value } });
        setPending(false);
        if (!finished.ok) return setRefused(finished.refused);
        onAdded();
    };

    return (
        <Stack gap={3}>
            <RefusalNote refused={refused} />
            <div>
                <Button tone="pink" icon="key-round" pending={pending} onClick={() => void add()}>
                    {CREDENTIALS_COPY.addPasskey}
                </Button>
            </div>
        </Stack>
    );
}
