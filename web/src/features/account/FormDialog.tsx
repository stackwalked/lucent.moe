import { type ReactNode, useId } from "react";
import { Button, type ButtonTone } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { ACCOUNT_COPY as C } from "./copy.ts";

// What an account action that needs input opens: the form in a dialog, one button for the verb
// the row said, sized to its label, and a way out. The caller holds `open` and the form's action
// (useActionState), so a refusal stays in the dialog and a success closes it.
export function FormDialog({
    open,
    onClose,
    title,
    confirm,
    tone = "pink",
    pending = false,
    action,
    children,
}: {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly title: string;
    readonly confirm: string;
    readonly tone?: ButtonTone;
    readonly pending?: boolean;
    readonly action: (form: FormData) => void;
    readonly children: ReactNode;
}) {
    const formId = useId();
    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={title}
            busy={pending}
            actions={
                <>
                    <Button tone="ghost" disabled={pending} onClick={onClose}>
                        {C.cancel}
                    </Button>
                    <Button tone={tone} type="submit" form={formId} pending={pending}>
                        {confirm}
                    </Button>
                </>
            }
        >
            <form id={formId} action={action} noValidate>
                <fieldset disabled={pending}>
                    <Stack gap={3}>{children}</Stack>
                </fieldset>
            </form>
        </Dialog>
    );
}
