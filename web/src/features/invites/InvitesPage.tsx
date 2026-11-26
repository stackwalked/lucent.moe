import type { EpochMs } from "@lucent/core/brands";
import type { WebContract } from "@lucent/rpc/web";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { z } from "zod";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Code } from "../../ui/Code/Code.tsx";
import { Copy } from "../../ui/Copy/Copy.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { AccountPage, State } from "../account/AccountPage.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { INVITES_COPY } from "./copy.ts";
import { createInvite, revokeInvite } from "./server.ts";

const route = getRouteApi("/_member/account/invites");

// The member area's loader data reaches this page untyped, so the shape comes from the contract.
type Listed = z.output<WebContract["invites.mine.list"]["output"]>;
type Invite = Listed["invites"][number];

type Created = { readonly link: string; readonly expiresAt: EpochMs };

// A member's invites: how many staff let them issue, each one issued and what became of it. A new
// invite's link shows here once, until the page is left or reloaded.
export function InvitesPage() {
    const listed: Outcome<Listed> = route.useLoaderData();
    const router = useRouter();
    const [created, setCreated] = useState<Created | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    if (!listed.ok) {
        return <AccountPage main={<RefusalNote refused={listed.refused} />} />;
    }
    const { granted, spent, invites } = listed.value;
    const left = Math.max(0, granted - spent);

    const create = async () => {
        setBusy("create");
        setRefused(null);
        const reply = await createInvite();
        setBusy(null);
        if (!reply.ok) {
            setRefused(reply.refused);
            return;
        }
        setCreated({
            link: `${window.location.origin}/invite#${reply.value.token}`,
            expiresAt: reply.value.expiresAt,
        });
        await router.invalidate();
    };
    const revoke = async (invite: Invite) => {
        setBusy(invite.inviteId);
        setRefused(null);
        const reply = await revokeInvite({ data: { inviteId: invite.inviteId } });
        setBusy(null);
        if (!reply.ok) setRefused(reply.refused);
        await router.invalidate();
    };

    const main = (
        <>
            <Section
                caption={INVITES_COPY.title}
                actions={
                    left > 0 ? (
                        <Button size="sm" pending={busy === "create"} onClick={() => void create()}>
                            {INVITES_COPY.create}
                        </Button>
                    ) : null
                }
            >
                <p>{granted === 0 ? INVITES_COPY.noAllowance : INVITES_COPY.vouch}</p>
                {created === null ? null : (
                    <Stack gap={2}>
                        <Stack direction="row" gap={2} align="center">
                            <Code>{created.link}</Code>
                            <Copy value={created.link} />
                        </Stack>
                        <p>{INVITES_COPY.shownOnce}</p>
                    </Stack>
                )}
                <RefusalNote refused={refused} />
            </Section>
            <Section caption={INVITES_COPY.yours}>
                {invites.length === 0 ? (
                    <Empty>{INVITES_COPY.none}</Empty>
                ) : (
                    <Table
                        caption={INVITES_COPY.yours}
                        rows={invites}
                        rowKey={(invite) => invite.inviteId}
                        columns={[
                            {
                                key: "state",
                                header: INVITES_COPY.state,
                                cell: (invite: Invite) => (
                                    <Status tone={invite.state === "unused" ? "pink" : "neutral"}>
                                        {INVITES_COPY.states[invite.state]}
                                    </Status>
                                ),
                            },
                            {
                                key: "account",
                                header: INVITES_COPY.account,
                                cell: (invite) =>
                                    invite.invitee === null
                                        ? INVITES_COPY.pending
                                        : (invite.invitee.username ?? INVITES_COPY.pending),
                            },
                            {
                                key: "created",
                                header: INVITES_COPY.createdAt,
                                cell: (invite) => <Time at={invite.createdAt} />,
                            },
                            {
                                key: "expires",
                                header: INVITES_COPY.expires,
                                cell: (invite) =>
                                    invite.state === "unused" ? (
                                        <Time at={invite.expiresAt} format="relative" />
                                    ) : null,
                            },
                            {
                                key: "revoke",
                                header: "",
                                align: "end",
                                cell: (invite) =>
                                    invite.state === "unused" ? (
                                        <Button
                                            size="sm"
                                            tone="danger"
                                            pending={busy === invite.inviteId}
                                            onClick={() => void revoke(invite)}
                                        >
                                            {INVITES_COPY.revoke}
                                        </Button>
                                    ) : null,
                            },
                        ]}
                    />
                )}
            </Section>
        </>
    );
    return (
        <AccountPage
            main={main}
            aside={
                <State
                    caption={INVITES_COPY.title}
                    items={[
                        {
                            label: INVITES_COPY.leftLabel,
                            value:
                                granted === 0
                                    ? INVITES_COPY.none
                                    : INVITES_COPY.left(left, granted),
                        },
                    ]}
                />
            }
        />
    );
}
