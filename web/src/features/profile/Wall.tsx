import { Link, useRouteContext } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { memberOf } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { type Closed, useClosedWords } from "../comments/closed.ts";
import { postingNote } from "../comments/posting.ts";
import { ReportButton } from "../comments/ReportButton.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { PROFILE_COPY as C } from "./copy.ts";
import { fetchWall, postWallComment, removeWallComment } from "./server.ts";
import styles from "./Wall.module.css";

type Listed = Extract<Awaited<ReturnType<typeof fetchWall>>, { readonly ok: true }>["value"];
type Comment = Listed["items"][number];

function Row({
    comment,
    onDelete,
}: {
    readonly comment: Comment;
    readonly onDelete: (id: string) => void;
}) {
    const { author } = comment;
    const { session } = useRouteContext({ from: "__root__" });
    const mine = author.username !== null && author.username === memberOf(session)?.username;
    return (
        <li className={styles.comment}>
            <span className={styles.pic}>
                <Avatar digest={author.avatar} size="small" />
            </span>
            <div className={styles.text}>
                <div className={styles.who}>
                    {author.username === null ? (
                        <span className={styles.name}>{C.unknownAuthor}</span>
                    ) : (
                        <Link
                            to="/members/$username"
                            params={{ username: author.username }}
                            className={styles.name}
                        >
                            {author.username}
                        </Link>
                    )}
                    <span className={styles.end}>
                        {comment.canDelete ? (
                            <Button size="sm" tone="ghost" onClick={() => onDelete(comment.id)}>
                                {C.delete}
                            </Button>
                        ) : null}
                        {mine ? null : <ReportButton kind="comment" targetId={comment.id} />}
                        <span className={styles.when}>
                            <Time at={comment.createdAt} format="relative" />
                        </span>
                    </span>
                </div>
                <p className={styles.body}>{comment.body}</p>
            </div>
        </li>
    );
}

// A profile's wall: newest first, the input under the list. The first page comes with the
// loader; posting reads the first page again, "more" appends older ones, both client-side.
export function Wall({
    username,
    first,
    closed,
    actions,
}: {
    readonly username: string;
    readonly first: Outcome<Listed>;
    // What closes the viewer's own words, when something does.
    readonly closed: Closed | null;
    // Beside the caption: the owner's switch for showing the wall, in edit mode.
    readonly actions?: ReactNode;
}) {
    const [items, setItems] = useState<readonly Comment[]>(first.ok ? first.value.items : []);
    const [next, setNext] = useState<string | null>(first.ok ? first.value.nextCursor : null);
    const [refused, setRefused] = useState<Refused | null>(first.ok ? null : first.refused);
    const [pending, setPending] = useState(false);
    const [formKey, setFormKey] = useState(0);
    const reload = async () => {
        const fresh = await fetchWall({ data: { username, cursor: null } });
        if (!fresh.ok) return setRefused(fresh.refused);
        setItems(fresh.value.items);
        setNext(fresh.value.nextCursor);
    };
    const post = async (form: FormData) => {
        const reply = await postWallComment({
            data: { username, body: String(form.get("body") ?? "") },
        });
        if (!reply.ok) return setRefused(reply.refused);
        setRefused(null);
        setFormKey((key) => key + 1);
        await reload();
    };
    const remove = async (id: string) => {
        const reply = await removeWallComment({ data: { id } });
        if (!reply.ok) return setRefused(reply.refused);
        setRefused(null);
        setItems((soFar) => soFar.filter((comment) => comment.id !== id));
    };
    const note = postingNote(refused);
    const closedWords = useClosedWords(closed);
    return (
        <Section caption={C.wall} {...(actions === undefined ? {} : { actions })}>
            <Stack gap={4}>
                {items.length === 0 ? (
                    <Empty>{C.noComments}</Empty>
                ) : (
                    <ol className={styles.list} aria-label={C.wall}>
                        {items.map((comment) => (
                            <Row key={comment.id} comment={comment} onDelete={remove} />
                        ))}
                    </ol>
                )}
                {next === null ? null : (
                    <div>
                        <Button
                            type="button"
                            tone="plain"
                            pending={pending}
                            onClick={async () => {
                                setPending(true);
                                const more = await fetchWall({ data: { username, cursor: next } });
                                setPending(false);
                                if (!more.ok) return setRefused(more.refused);
                                setItems((soFar) => [...soFar, ...more.value.items]);
                                setNext(more.value.nextCursor);
                            }}
                        >
                            {C.more}
                        </Button>
                    </div>
                )}
                <form action={post} key={formKey}>
                    <Stack gap={3}>
                        <RefusalNote
                            refused={refused}
                            {...(note === undefined ? {} : { extra: note })}
                        />
                        <TextArea
                            name="body"
                            label={C.writeOn(username)}
                            maxLength={2000}
                            required
                            size="line"
                            disabled={closedWords !== null}
                            {...(closedWords === null ? {} : { placeholder: closedWords })}
                            end={
                                <Button type="submit" disabled={closedWords !== null}>
                                    {C.post}
                                </Button>
                            }
                        />
                    </Stack>
                </form>
            </Stack>
        </Section>
    );
}
