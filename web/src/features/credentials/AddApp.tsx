import { useActionState, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { CodeInput } from "../../ui/CodeInput/CodeInput.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { useStepUp } from "../step-up/StepUp.tsx";
import { CREDENTIALS_COPY } from "./copy.ts";
import styles from "./forms.module.css";
import { QrCode } from "./QrCode.tsx";
import { confirmTotp, enrollTotp } from "./server.ts";

type Pending = { readonly secret: string; readonly rows: readonly string[] };

// The key in groups of four, for typing in by hand.
function grouped(secret: string): string {
    return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

// Adding an authenticator app: a QR code and its key, then one code from the app to prove it
// holds the same secret. Until then it's stored unconfirmed and signs nothing in.
export function AddApp({ onAdded }: { readonly onAdded: () => void }) {
    const guard = useStepUp();
    const [pending, setPending] = useState<Pending | null>(null);
    const [starting, setStarting] = useState(false);
    const [startRefused, setStartRefused] = useState<Refused | null>(null);

    const start = async () => {
        setStarting(true);
        setStartRefused(null);
        const reply = await guard(() => enrollTotp());
        setStarting(false);
        if (!reply.ok) return setStartRefused(reply.refused);
        setPending(reply.value);
    };

    const [refused, submit, confirming] = useActionState(
        async (_: Refused | null, form: FormData) => {
            const code = String(form.get("code") ?? "");
            const reply = await guard(() => confirmTotp({ data: { code } }));
            if (reply.ok) {
                setPending(null);
                onAdded();
                return null;
            }
            return reply.refused;
        },
        null,
    );

    if (pending === null) {
        return (
            <Stack gap={3}>
                <RefusalNote refused={startRefused} />
                <div>
                    <Button icon="smartphone" pending={starting} onClick={() => void start()}>
                        {CREDENTIALS_COPY.addApp}
                    </Button>
                </div>
            </Stack>
        );
    }
    return (
        <Stack gap={4}>
            <p>{CREDENTIALS_COPY.scan}</p>
            <QrCode rows={pending.rows} label={CREDENTIALS_COPY.qrLabel} />
            <p>
                {CREDENTIALS_COPY.key}:{" "}
                <span className={styles.key}>{grouped(pending.secret)}</span>
            </p>
            <form action={submit} noValidate className={styles.form}>
                <fieldset disabled={confirming}>
                    <Stack gap={4}>
                        <CodeInput
                            name="code"
                            label={CREDENTIALS_COPY.code}
                            hint={CREDENTIALS_COPY.codeHint}
                        />
                        <RefusalNote refused={refused} />
                    </Stack>
                </fieldset>
            </form>
        </Stack>
    );
}
