import { useActionState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { NewPassword } from "../../ui/NewPassword/NewPassword.tsx";
import { FormDialog } from "../account/FormDialog.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { useStepUp } from "../step-up/StepUp.tsx";
import { CREDENTIALS_COPY as C } from "./copy.ts";
import { setPassword } from "./server.ts";

// Setting or changing the password from the account page. The username rides along hidden, so
// password managers save the pair together.
export function PasswordDialog({
    open,
    adding,
    username,
    onClose,
    onSet,
}: {
    readonly open: boolean;
    readonly adding: boolean;
    readonly username: string;
    readonly onClose: () => void;
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
        <FormDialog
            open={open}
            onClose={onClose}
            title={adding ? C.addPassword : C.changePassword}
            confirm={adding ? C.add : C.change}
            pending={pending}
            action={submit}
        >
            <input
                type="text"
                name="username"
                autoComplete="username"
                value={username}
                readOnly
                hidden
            />
            <NewPassword name="password" label={C.newPassword} />
            <RefusalNote refused={refused} />
        </FormDialog>
    );
}
