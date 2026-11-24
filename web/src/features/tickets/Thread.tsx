import type { EpochMs } from "@lucent/core/scalars";
import { useRouter } from "@tanstack/react-router";
import { useActionState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { TICKETS_COPY } from "./copy.ts";
import styles from "./Thread.module.css";

export type ThreadMessage = {
    readonly id: string;
    readonly fromStaff: boolean;
    readonly body: string;
    readonly at: EpochMs;
};

// A ticket's messages, oldest first, each said by "you" or "staff" (or, for staff reading, by
// whoever wrote it).
export function Thread({
    caption,
    messages,
    authorOf,
}: {
    readonly caption: string;
    readonly messages: readonly ThreadMessage[];
    readonly authorOf?: (message: ThreadMessage) => string;
}) {
    const author =
        authorOf ??
        ((message: ThreadMessage) => (message.fromStaff ? TICKETS_COPY.staff : TICKETS_COPY.you));
    return (
        <Table
            caption={caption}
            rows={messages}
            rowKey={(message) => message.id}
            columns={[
                { key: "author", header: "", cell: author },
                {
                    key: "body",
                    header: TICKETS_COPY.body,
                    cell: (message) => <span className={styles.body}>{message.body}</span>,
                },
                {
                    key: "at",
                    header: "",
                    cell: (message) => <Time at={message.at} format="relative" />,
                },
            ]}
        />
    );
}

// The box under a thread: one message, sent, then the page reloads to show it.
export function Reply({
    label,
    submitLabel,
    hint,
    send,
}: {
    readonly label: string;
    readonly submitLabel: string;
    readonly hint?: string;
    readonly send: (body: string) => Promise<Outcome<null>>;
}) {
    const router = useRouter();
    const [refused, submit, pending] = useActionState(
        async (_: Refused | null, form: FormData): Promise<Refused | null> => {
            const reply = await send(String(form.get("body") ?? ""));
            if (!reply.ok) return reply.refused;
            await router.invalidate();
            return null;
        },
        null,
    );
    return (
        <form action={submit}>
            <Stack gap={2}>
                <TextArea name="body" label={label} maxLength={4000} required />
                {hint === undefined ? null : <p>{hint}</p>}
                <RefusalNote refused={refused} />
                <div>
                    <Button type="submit" pending={pending}>
                        {submitLabel}
                    </Button>
                </div>
            </Stack>
        </form>
    );
}
