import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Named } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { Comments } from "../comments/Comments.tsx";
import { postingNote } from "../comments/posting.ts";
import { ReportButton } from "../comments/ReportButton.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { GUIDES_COPY } from "./copy.ts";
import styles from "./Guide.module.css";
import { saveGuide } from "./server.ts";
import { GUIDES_TITLE } from "./title.ts";

const route = getRouteApi("/_member/guides/$guideId");

export function GuidePage() {
    const { guideId } = route.useParams();
    const { guide, comments } = route.useLoaderData();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const [editing, setEditing] = useState(false);
    const editArea = useRef<HTMLDivElement>(null);
    const editToggle = useRef<HTMLSpanElement>(null);
    const hasOpened = useRef(false);
    // Focus follows the form: into its title as it opens, back to "edit" as it closes (not on
    // the first render, when nothing was open).
    useEffect(() => {
        if (editing) {
            hasOpened.current = true;
            editArea.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
        } else if (hasOpened.current) {
            editToggle.current?.querySelector("button")?.focus();
        }
    }, [editing]);
    const close = () => {
        setEditing(false);
        setRefused(null);
    };
    const save = async (form: FormData) => {
        const reply = await saveGuide({
            data: {
                id: guideId,
                title: String(form.get("title") ?? ""),
                body: String(form.get("body") ?? ""),
            },
        });
        if (!reply.ok) return setRefused(reply.refused);
        close();
        await router.invalidate();
    };
    if (!guide.ok) {
        return (
            <Page title={GUIDES_TITLE}>
                <RefusalNote refused={guide.refused} />
            </Page>
        );
    }
    const note = postingNote(refused);
    return (
        <Page
            title={guide.value.title}
            trail={
                <Link to="/products/$productId" params={{ productId: guide.value.productId }}>
                    {GUIDES_COPY.back}
                </Link>
            }
            actions={
                guide.value.isMine ? (
                    <span ref={editToggle}>
                        <Button
                            size="sm"
                            icon="pencil"
                            pressed={editing}
                            onClick={() => (editing ? close() : setEditing(true))}
                        >
                            {GUIDES_COPY.edit}
                        </Button>
                    </span>
                ) : null
            }
        >
            <Stack gap={6}>
                <p>
                    <Named avatar={guide.value.author.avatar}>
                        {GUIDES_COPY.by(guide.value.author.username)}
                    </Named>{" "}
                    <Time at={guide.value.updatedAt} format="relative" />
                </p>
                <p className={styles.body}>{guide.value.body}</p>
                {guide.value.isMine ? null : <ReportButton kind="guide" targetId={guideId} />}
                {editing ? (
                    <Section caption={GUIDES_COPY.edit}>
                        <div ref={editArea}>
                            <form action={save} key={guide.value.updatedAt}>
                                <Stack gap={3}>
                                    <RefusalNote
                                        refused={refused}
                                        {...(note === undefined ? {} : { extra: note })}
                                    />
                                    <TextField
                                        name="title"
                                        label={GUIDES_COPY.titleField}
                                        required
                                        maxLength={120}
                                        defaultValue={guide.value.title}
                                    />
                                    <TextArea
                                        name="body"
                                        label={GUIDES_COPY.bodyField}
                                        maxLength={20000}
                                        required
                                        defaultValue={guide.value.body}
                                    />
                                    <Stack direction="row" gap={2}>
                                        <Button type="submit">{GUIDES_COPY.save}</Button>
                                        <Button tone="ghost" onClick={close}>
                                            {GUIDES_COPY.cancel}
                                        </Button>
                                    </Stack>
                                </Stack>
                            </form>
                        </div>
                    </Section>
                ) : null}
                <Comments
                    guideId={guideId}
                    outcome={comments}
                    onNext={(cursor) =>
                        void router.navigate({
                            to: "/guides/$guideId",
                            params: { guideId },
                            search: { cursor },
                        })
                    }
                />
            </Stack>
        </Page>
    );
}
