import { useId, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { COMMENTS_COPY } from "./copy.ts";
import { reportContent } from "./server.ts";
import styles from "./TextArea.module.css";
import { TextArea } from "./TextArea.tsx";

type Kind = "comment" | "shout" | "guide";

// Any member flags anything a member wrote; staff see it in the moderation queue.
export function ReportButton({
    kind,
    targetId,
}: {
    readonly kind: Kind;
    readonly targetId: string;
}) {
    const formId = useId();
    const [open, setOpen] = useState(false);
    const [sent, setSent] = useState(false);
    const [pending, setPending] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    const submit = async (form: FormData) => {
        setPending(true);
        const reason = form.get("reason");
        const reply = await reportContent({
            data: {
                kind,
                targetId,
                reason: reason === "abuse" || reason === "other" ? reason : "spam",
                note: String(form.get("note") ?? ""),
            },
        });
        setPending(false);
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) setSent(true);
    };
    const close = () => {
        setOpen(false);
        setRefused(null);
    };
    return (
        <>
            <Button size="sm" tone="ghost" onClick={() => setOpen(true)}>
                {sent ? COMMENTS_COPY.reported : COMMENTS_COPY.report}
            </Button>
            <Dialog
                open={open}
                onClose={close}
                title={COMMENTS_COPY.reportTitle}
                busy={pending}
                actions={
                    sent ? (
                        <Button onClick={close}>{COMMENTS_COPY.done}</Button>
                    ) : (
                        <>
                            <Button tone="ghost" disabled={pending} onClick={close}>
                                {COMMENTS_COPY.cancel}
                            </Button>
                            <Button type="submit" form={formId} pending={pending}>
                                {COMMENTS_COPY.send}
                            </Button>
                        </>
                    )
                }
            >
                {sent ? (
                    <p>{COMMENTS_COPY.thanks}</p>
                ) : (
                    <form id={formId} action={submit}>
                        <Stack gap={4}>
                            <label className={styles.field}>
                                <span className={styles.label}>{COMMENTS_COPY.reason}</span>
                                <select name="reason" className={styles.control}>
                                    <option value="spam">{COMMENTS_COPY.spam}</option>
                                    <option value="abuse">{COMMENTS_COPY.abuse}</option>
                                    <option value="other">{COMMENTS_COPY.other}</option>
                                </select>
                            </label>
                            <TextArea name="note" label={COMMENTS_COPY.note} maxLength={500} />
                            <RefusalNote refused={refused} />
                        </Stack>
                    </form>
                )}
            </Dialog>
        </>
    );
}
