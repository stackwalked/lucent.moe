import type { EpochMs } from "@lucent/core/brands";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Code } from "../../ui/Code/Code.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { RowAction, SettingRow, SettingRows } from "../../ui/SettingRow/SettingRow.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { ACCOUNT_COPY } from "../account/copy.ts";
import { Note } from "../account/Note.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { INVITES_COPY as C } from "./copy.ts";
import type { fetchInvites } from "./server.ts";
import { createInvite, revokeInvite } from "./server.ts";

type Listed = Extract<Awaited<ReturnType<typeof fetchInvites>>, { ok: true }>["value"];
type Invite = Listed["invites"][number];
type Created = { readonly link: string; readonly expiresAt: EpochMs };

// Who the member invited, and the invites still waiting. A new invite's link shows once, in the
// dialog that made it; later the platform no longer has it, so a waiting invite can only be revoked.
export function InvitesSection({ invites }: { readonly invites: Outcome<Listed> }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [created, setCreated] = useState<Created | null>(null);
    const [creating, setCreating] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    const [revoking, setRevoking] = useState<string | null>(null);

    if (!invites.ok) {
        return (
            <Section caption={C.title}>
                <RefusalNote refused={invites.refused} />
            </Section>
        );
    }
    const { granted, spent } = invites.value;
    const left = Math.max(0, granted - spent);
    const shown = invites.value.invites.filter(
        (invite) => invite.state === "unused" || invite.state === "used",
    );

    const create = async () => {
        setCreating(true);
        setRefused(null);
        const reply = await createInvite();
        setCreating(false);
        if (!reply.ok) return setRefused(reply.refused);
        setCreated({
            link: `${window.location.origin}/invite#${reply.value.token}`,
            expiresAt: reply.value.expiresAt,
        });
        await router.invalidate();
    };
    const revoke = async (invite: Invite) => {
        setRevoking(invite.inviteId);
        setRefused(null);
        const reply = await revokeInvite({ data: { inviteId: invite.inviteId } });
        setRevoking(null);
        if (!reply.ok) setRefused(reply.refused);
        await router.invalidate();
    };
    const close = () => {
        setOpen(false);
        setCreated(null);
        setRefused(null);
    };

    return (
        <Section
            caption={C.title}
            actions={granted === 0 ? undefined : <Note>{C.left(left)}</Note>}
        >
            {open ? null : <RefusalNote refused={refused} />}
            <SettingRows label={C.title}>
                {shown.map((invite) => (
                    <SettingRow
                        key={invite.inviteId}
                        layout="item"
                        name={
                            invite.state === "unused"
                                ? C.pending
                                : (invite.invitee?.username ?? C.unknown)
                        }
                        value={
                            invite.state === "unused" ? (
                                <>
                                    {C.until} <Time at={invite.expiresAt} format="day" />
                                </>
                            ) : (
                                <Time at={invite.createdAt} format="month" />
                            )
                        }
                        action={
                            invite.state === "unused" ? (
                                <RowAction
                                    tone="quiet"
                                    label={C.revokeLabel}
                                    pending={revoking === invite.inviteId}
                                    onClick={() => void revoke(invite)}
                                >
                                    {C.revoke}
                                </RowAction>
                            ) : undefined
                        }
                    />
                ))}
                {shown.length === 0 && left === 0 ? (
                    <SettingRow layout="item" name={C.none} />
                ) : null}
                {left > 0 ? (
                    <SettingRow
                        layout="item"
                        name={
                            <RowAction tone="pink" onClick={() => setOpen(true)}>
                                {C.newInvite}
                            </RowAction>
                        }
                    />
                ) : null}
            </SettingRows>
            <Dialog
                open={open}
                onClose={close}
                title={C.newInvite}
                busy={creating}
                actions={
                    created === null ? (
                        <>
                            <Button tone="ghost" disabled={creating} onClick={close}>
                                {ACCOUNT_COPY.cancel}
                            </Button>
                            <Button tone="pink" pending={creating} onClick={() => void create()}>
                                {C.create}
                            </Button>
                        </>
                    ) : (
                        <Button tone="pink" onClick={close}>
                            {C.done}
                        </Button>
                    )
                }
            >
                <Stack gap={3}>
                    {created === null ? (
                        <p>{C.vouch}</p>
                    ) : (
                        <>
                            <Code>{created.link}</Code>
                            <p>{C.shownOnce}</p>
                        </>
                    )}
                    <RefusalNote refused={refused} />
                </Stack>
            </Dialog>
        </Section>
    );
}
