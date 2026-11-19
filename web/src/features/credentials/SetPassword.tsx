import { useActionState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { NewPassword } from "../../ui/NewPassword/NewPassword.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { useStepUp } from "../step-up/StepUp.tsx";
import { CREDENTIALS_COPY } from "./copy.ts";
import styles from "./forms.module.css";
import { setPassword } from "./server.ts";

// The username rides along hidden, so password managers save the pair together.
export function SetPassword({
    username,
    onSet,
}: {
    readonly username: string;
    readonly onSet: () => void;
}) {
    const guard = useStepUp();
    const [refused, submit, pending] = useActionState(async (_: Refused | null, form: FormData) => {
        const password = String(form.get("password") ?? "");
        const reply = await guard(() => setPassword({ data: { password } }));
        if (reply.ok) {
            onSet();
            return null;
        }
        return reply.refused;
    }, null);
    return (
        <form action={submit} noValidate className={styles.form}>
            <fieldset disabled={pending}>
                <Stack gap={4}>
                    <input
                        type="text"
                        name="username"
                        autoComplete="username"
                        value={username}
                        readOnly
                        hidden
                    />
                    <NewPassword name="password" label={CREDENTIALS_COPY.newPassword} />
                    <RefusalNote refused={refused} />
                    <div>
                        <Button type="submit" pending={pending}>
                            {CREDENTIALS_COPY.setPassword}
                        </Button>
                    </div>
                </Stack>
            </fieldset>
        </form>
    );
}
