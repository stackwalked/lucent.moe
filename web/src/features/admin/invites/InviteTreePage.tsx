import { getRouteApi } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { AccountStatusBadge } from "../accounts/status.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { INVITE_TREE_COPY } from "./copy.ts";
import styles from "./InviteTreePage.module.css";

const route = getRouteApi("/_admin/admin/invites");

type Tree = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Member = Tree["members"][number];

// Platform sends everyone on an edge, oldest first, each naming who invited them; nested here.
// An account whose inviter is missing from the list (past the cap) starts a tree of its own.
function nest(members: readonly Member[]) {
    const listed = new Set(members.map((member) => member.accountId));
    const children = new Map<string, Member[]>();
    const roots: Member[] = [];
    for (const member of members) {
        if (member.invitedBy === null || !listed.has(member.invitedBy)) {
            roots.push(member);
            continue;
        }
        const siblings = children.get(member.invitedBy) ?? [];
        siblings.push(member);
        children.set(member.invitedBy, siblings);
    }
    return { roots, childrenOf: (member: Member) => children.get(member.accountId) ?? [] };
}

export function InviteTreePage() {
    const read = route.useLoaderData();
    if (!read.ok) {
        return (
            <Page title={INVITE_TREE_COPY.title}>
                <RefusalNote refused={read.refused} />
            </Page>
        );
    }
    const { roots, childrenOf } = nest(read.value.members);
    const branch = (members: readonly Member[]) => (
        <ul className={styles.tree}>
            {members.map((member) => (
                <li key={member.accountId}>
                    <span className={styles.node}>
                        <Who
                            accountId={member.accountId}
                            username={member.username}
                            pending={ADMIN_COPY.pending}
                        />
                        {member.status === "active" ? null : (
                            <AccountStatusBadge status={member.status} />
                        )}
                        <span>{INVITE_TREE_COPY.invitees(member.invitees)}</span>
                        <Status tone={member.strikes.ever === 0 ? "neutral" : "shu"}>
                            {INVITE_TREE_COPY.strikes(member.strikes.ever, member.strikes.now)}
                        </Status>
                    </span>
                    {childrenOf(member).length === 0 ? null : branch(childrenOf(member))}
                </li>
            ))}
        </ul>
    );
    return (
        <Page title={INVITE_TREE_COPY.title}>
            {read.value.truncated ? <p>{INVITE_TREE_COPY.truncated}</p> : null}
            {roots.length === 0 ? <Empty>{INVITE_TREE_COPY.none}</Empty> : branch(roots)}
        </Page>
    );
}
