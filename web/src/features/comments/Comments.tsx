import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Named } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Messages } from "../../ui/Messages/Messages.tsx";
import { Pager } from "../../ui/Pager/Pager.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { COMMENTS_COPY } from "./copy.ts";
import { postingNote } from "./posting.ts";
import { ReportButton } from "./ReportButton.tsx";
import type { fetchComments } from "./server.ts";
import { postComment } from "./server.ts";
import { TextArea } from "./TextArea.tsx";

type Listed = Extract<Awaited<ReturnType<typeof fetchComments>>, { ok: true }>["value"];

export function Comments({
    guideId,
    outcome,
    onNext,
}: {
    readonly guideId: string;
    readonly outcome: Outcome<Listed>;
    readonly onNext: (cursor: string) => void;
}) {
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const post = async (form: FormData) => {
        const reply = await postComment({
            data: { guideId, body: String(form.get("body") ?? "") },
        });
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    const shown = outcome.ok ? refused : outcome.refused;
    return (
        <Section caption={COMMENTS_COPY.title}>
            <Stack gap={4}>
                <RefusalNote refused={shown} {...extraOf(shown)} />
                {!outcome.ok ? null : outcome.value.items.length === 0 ? (
                    <Empty>{COMMENTS_COPY.none}</Empty>
                ) : (
                    <>
                        <Messages
                            label={COMMENTS_COPY.title}
                            messages={outcome.value.items.map((row) => ({
                                key: row.id,
                                at: row.createdAt,
                                body: row.body,
                                author: (
                                    <Named avatar={row.author.avatar}>
                                        {row.isMine
                                            ? COMMENTS_COPY.you
                                            : COMMENTS_COPY.author(row.author.username)}
                                    </Named>
                                ),
                                ...(row.isMine
                                    ? {}
                                    : {
                                          aside: <ReportButton kind="comment" targetId={row.id} />,
                                      }),
                            }))}
                        />
                        <Pager nextCursor={outcome.value.nextCursor} onNext={onNext} />
                    </>
                )}
                {outcome.ok ? (
                    <form action={post} key={outcome.value.items.length}>
                        <Stack gap={2}>
                            <TextArea
                                name="body"
                                label={COMMENTS_COPY.body}
                                maxLength={2000}
                                required
                            />
                            <div>
                                <Button type="submit">{COMMENTS_COPY.post}</Button>
                            </div>
                        </Stack>
                    </form>
                ) : null}
            </Stack>
        </Section>
    );
}

function extraOf(refused: Refused | null): { readonly extra?: string } {
    const note = postingNote(refused);
    return note === undefined ? {} : { extra: note };
}
