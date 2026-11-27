import { newOperationId, type OperationId } from "@lucent/core/brands";
import { systemCryptoRng } from "@lucent/core/rng";
import type { Action } from "@lucent/policy/action-list";
import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useActionState, useId, useRef, useState } from "react";
import type { Outcome, Refused } from "../../../server/outcome.ts";
import { Button, type ButtonTone } from "../../../ui/Button/Button.tsx";
import { Dialog } from "../../../ui/Dialog/Dialog.tsx";
import type { IconName } from "../../../ui/Icon/names.ts";
import { Refusal } from "../../../ui/Refusal/Refusal.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { useStaffAction } from "../staff.ts";
import { ACCOUNTS_COPY } from "./copy.ts";

// Each opening of the dialog is one attempt: its own operationId, so a double submit or the retry
// after a step-up acts once, and its own fields and refusal, so nothing typed or refused last time
// shows again. An answer that arrives after the dialog closed belongs to no opening and is
// dropped: a setup link must never surface in the next one.
type Opening = { readonly generation: number; readonly operationId: OperationId };

type Answer<T> =
    | { readonly generation: number; readonly refused: Refused }
    | { readonly generation: number; readonly problem: string }
    | { readonly generation: number; readonly value: T };

// One staff action: a button, a dialog with whatever the action asks for, and the call. What a
// success returns, if anything, stays shown until the dialog closes.
export function AccountAction<T>({
    action,
    label,
    submitLabel = label,
    title,
    tone = "plain",
    icon,
    fields,
    run,
    validate,
    shown,
    onOpen,
}: {
    readonly action: Action;
    readonly label: string;
    readonly submitLabel?: string;
    readonly title: string;
    readonly tone?: ButtonTone;
    readonly icon?: IconName;
    readonly fields: ReactNode;
    readonly run: (form: FormData, operationId: OperationId) => Promise<Outcome<T>>;
    // A rule across fields that no one input's constraints can state; its message stops the send.
    readonly validate?: (form: FormData) => string | undefined;
    // What to show once it worked; without it the dialog closes.
    readonly shown?: (value: T) => ReactNode;
    // Called as the dialog opens, for a dialog that has something to read first.
    readonly onOpen?: () => void;
}) {
    const router = useRouter();
    const staff = useStaffAction();
    const formId = useId();
    const [opening, setOpening] = useState<Opening | null>(null);
    // The opening an answer is checked against once it arrives, after the render it started in.
    const live = useRef<number | null>(null);
    const generations = useRef(0);

    const open = () => {
        generations.current += 1;
        live.current = generations.current;
        setOpening({
            generation: generations.current,
            operationId: newOperationId(systemCryptoRng),
        });
        onOpen?.();
    };
    const close = () => {
        live.current = null;
        setOpening(null);
    };

    const [answer, submit, pending] = useActionState(
        async (_: Answer<T> | null, form: FormData): Promise<Answer<T> | null> => {
            const asked = opening;
            if (asked === null) return null;
            const problem = validate?.(form);
            if (problem !== undefined) return { generation: asked.generation, problem };
            const reply = await staff(action, () => run(form, asked.operationId));
            if (live.current !== asked.generation) return null;
            if (!reply.ok) return { generation: asked.generation, refused: reply.refused };
            await router.invalidate();
            if (shown === undefined) {
                close();
                return null;
            }
            return { generation: asked.generation, value: reply.value };
        },
        null,
    );
    const mine = answer !== null && answer.generation === opening?.generation ? answer : null;
    const result = mine !== null && "value" in mine ? mine : null;

    return (
        <>
            <Button size="sm" tone={tone} {...(icon === undefined ? {} : { icon })} onClick={open}>
                {label}
            </Button>
            <Dialog
                open={opening !== null}
                onClose={close}
                title={title}
                busy={pending}
                actions={
                    result !== null ? (
                        <Button onClick={close}>{ACCOUNTS_COPY.done}</Button>
                    ) : (
                        <>
                            <Button tone="ghost" disabled={pending} onClick={close}>
                                {ACCOUNTS_COPY.cancel}
                            </Button>
                            <Button tone={tone} type="submit" form={formId} pending={pending}>
                                {submitLabel}
                            </Button>
                        </>
                    )
                }
            >
                {result !== null && shown !== undefined ? (
                    shown(result.value)
                ) : (
                    <form key={opening?.generation} id={formId} action={submit} noValidate>
                        <fieldset disabled={pending}>
                            <Stack gap={4}>
                                {fields}
                                {mine !== null && "problem" in mine ? (
                                    <Refusal>{mine.problem}</Refusal>
                                ) : null}
                                <RefusalNote
                                    refused={
                                        mine !== null && "refused" in mine ? mine.refused : null
                                    }
                                    overrides={{ NO_PASSKEY: ADMIN_COPY.needsPasskey }}
                                />
                            </Stack>
                        </fieldset>
                    </form>
                )}
            </Dialog>
        </>
    );
}
