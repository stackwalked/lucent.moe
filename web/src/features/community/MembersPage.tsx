import { Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { Outcome } from "../../server/outcome.ts";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Find } from "../../ui/Find/Find.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { RoleLabel } from "../../ui/RoleLabel/RoleLabel.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { COMMUNITY_COPY as C } from "./copy.ts";
import styles from "./MembersPage.module.css";
import { usePresence } from "./presence.ts";
import { fetchMembers } from "./server.ts";

type Listed = Extract<Awaited<ReturnType<typeof fetchMembers>>, { readonly ok: true }>["value"];
type Member = Listed["items"][number];

export type MembersData = {
    readonly find: string | null;
    readonly members: Outcome<Listed>;
    readonly newest: Outcome<Listed>;
};

// The picture's slot keeps its size when there is none, so names line up down a list.
function Pic({ digest }: { readonly digest: string | null }) {
    return (
        <span className={styles.pic}>
            <Avatar digest={digest} size="small" />
        </span>
    );
}

function MemberRow({ member }: { readonly member: Member }) {
    return (
        <Link
            to="/members/$username"
            params={{ username: member.username }}
            className={styles.member}
        >
            <Pic digest={member.avatar} />
            <span className={styles.text}>
                <span className={styles.name}>{member.username}</span>
                {member.role === null ? null : (
                    <RoleLabel name={member.role.name} color={member.role.color} />
                )}
            </span>
            <span className={styles.number}>{C.memberNo(member.memberNo)}</span>
            <span className={styles.joined}>
                <Time at={member.joinedAt} format="month" />
            </span>
        </Link>
    );
}

// The first page comes with the loader; "more" appends the next one client-side, keeping the
// address as it is. The caller keys it by the search, so a new find starts a new list.
function MemberList({ first, find }: { readonly first: Listed; readonly find: string | null }) {
    const [members, setMembers] = useState<readonly Member[]>(first.items);
    const [next, setNext] = useState<string | null>(first.next);
    const [pending, setPending] = useState(false);
    if (members.length === 0) return <Empty>{C.noMembers}</Empty>;
    return (
        <>
            <div className={styles.list}>
                {members.map((member) => (
                    <MemberRow key={member.username} member={member} />
                ))}
            </div>
            {next === null ? null : (
                <div className={styles.moreRow}>
                    <Button
                        type="button"
                        tone="plain"
                        pending={pending}
                        onClick={async () => {
                            setPending(true);
                            const more = await fetchMembers({
                                data: {
                                    cursor: next,
                                    ...(find === null ? {} : { text: find }),
                                },
                            });
                            setPending(false);
                            if (!more.ok) return;
                            setMembers((soFar) => [...soFar, ...more.value.items]);
                            setNext(more.value.next);
                        }}
                    >
                        {C.more}
                    </Button>
                </div>
            )}
        </>
    );
}

function FindMembers({ find }: { readonly find: string | null }) {
    const router = useRouter();
    return (
        <Find
            key={find ?? ""}
            label={C.find}
            value={find}
            onFind={(text) =>
                void router.navigate({
                    to: "/community",
                    search: text === "" ? {} : { find: text },
                })
            }
        />
    );
}
function Row({
    username,
    avatar,
    end,
}: {
    readonly username: string;
    readonly avatar: string | null;
    readonly end: ReactNode;
}) {
    return (
        <Link to="/members/$username" params={{ username }} className={styles.side}>
            <Pic digest={avatar} />
            <span className={styles.name}>{username}</span>
            <span className={styles.end}>{end}</span>
        </Link>
    );
}

function HereNow() {
    const presence = usePresence();
    if (presence === null || presence.roster.length === 0) return null;
    return (
        <Section caption={C.hereNow}>
            <div className={styles.sideList}>
                {presence.roster.map((entry) => (
                    <Row
                        key={entry.username}
                        username={entry.username}
                        avatar={entry.avatar}
                        end={entry.inGame ? C.inGame : null}
                    />
                ))}
            </div>
        </Section>
    );
}

const NEWEST_SHOWN = 3;

function Newest({ newest }: { readonly newest: Outcome<Listed> }) {
    if (!newest.ok || newest.value.items.length === 0) return null;
    return (
        <Section caption={C.newest}>
            <div className={styles.sideList}>
                {newest.value.items.slice(0, NEWEST_SHOWN).map((member) => (
                    <Row
                        key={member.username}
                        username={member.username}
                        avatar={member.avatar}
                        end={<Time at={member.joinedAt} format="day" />}
                    />
                ))}
            </div>
        </Section>
    );
}

// The community's first tab: everyone who may be listed, as rows, with who is here now and who
// joined last beside them. The title stays for screen readers; the tabs and "find" are the main
// column's head row, and the aside's first caption is level with it.
export function MembersPage({ data }: { readonly data: MembersData }) {
    const { find, members, newest } = data;
    return (
        <Page title={C.title} hideTitle>
            <Columns
                head={{
                    lead: <h1 className={styles.title}>{C.members}</h1>,
                    actions: <FindMembers find={find} />,
                }}
                main={
                    members.ok ? (
                        <MemberList key={find ?? ""} first={members.value} find={find} />
                    ) : (
                        <RefusalNote refused={members.refused} />
                    )
                }
                aside={
                    <Stack gap={6}>
                        <HereNow />
                        <Newest newest={newest} />
                    </Stack>
                }
            />
        </Page>
    );
}
