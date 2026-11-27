import { useActionState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { CodeInput } from "../../ui/CodeInput/CodeInput.tsx";
import { FormDialog } from "../account/FormDialog.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { useStepUp } from "../step-up/StepUp.tsx";
import { CREDENTIALS_COPY as C } from "./copy.ts";
import styles from "./forms.module.css";
import { QrCode } from "./QrCode.tsx";
import { confirmTotp } from "./server.ts";

export type Enrolled = { readonly secret: string; readonly rows: readonly string[] };

// The key in groups of four, for typing in by hand.
function grouped(secret: string): string {
    return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

// An authenticator app that was just enrolled: its QR code and key, then one code from the app
// to prove it holds the same secret. Until then it's stored unconfirmed and signs nothing in.
export function AppDialog({
    enrolled,
    onClose,
    onAdded,
}: {
    readonly enrolled: Enrolled | null;
    readonly onClose: () => void;
    readonly onAdded: () => void;
}) {
    const guard = useStepUp();
    const [refused, submit, pending] = useActionState(async (_: Refused | null, form: FormData) => {
        const code = String(form.get("code") ?? "");
        const reply = await guard(() => confirmTotp({ data: { code } }));
        if (reply.ok) {
            onAdded();
            return null;
        }
        return reply.refused;
    }, null);
    return (
        <FormDialog
            open={enrolled !== null}
            onClose={onClose}
            title={C.addApp}
            confirm={C.add}
            pending={pending}
            action={submit}
        >
            {enrolled === null ? null : (
                <>
                    <p>{C.scan}</p>
                    <QrCode rows={enrolled.rows} label={C.qrLabel} />
                    <p>
                        {C.key}: <span className={styles.key}>{grouped(enrolled.secret)}</span>
                    </p>
                    <CodeInput name="code" label={C.code} hint={C.codeHint} />
                    <RefusalNote refused={refused} />
                </>
            )}
        </FormDialog>
    );
}
