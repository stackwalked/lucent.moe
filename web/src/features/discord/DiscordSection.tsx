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
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { DISCORD_COPY as C } from "./copy.ts";
import { removeDiscordLink, startDiscordLink } from "./server.ts";

type Issued = { readonly code: string; readonly expiresAt: EpochMs };

// Linking starts here and ends in Discord: the code goes to the bot's /link, which is how the
// service learns which Discord user is this account. Nothing is linked until the bot has it, so
// the page reads the link again when the dialog closes.
export function DiscordSection({
    link,
}: {
    readonly link: Outcome<{ readonly linkedAt: EpochMs | null }>;
}) {
    const router = useRouter();
    const [linking, setLinking] = useState(false);
    const [unlinking, setUnlinking] = useState(false);
    const [issued, setIssued] = useState<Issued | null>(null);
    const [pending, setPending] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);

    if (!link.ok) {
        return (
            <Section caption={C.title}>
                <RefusalNote refused={link.refused} />
            </Section>
        );
    }
    const linkedAt = link.value.linkedAt;

    const getCode = async () => {
        setPending(true);
        const reply = await startDiscordLink();
        setPending(false);
        setRefused(reply.ok ? null : reply.refused);
        setIssued(reply.ok ? reply.value : null);
        if (!reply.ok) await router.invalidate();
    };
    const unlink = async () => {
        setPending(true);
        const reply = await removeDiscordLink();
        setPending(false);
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) setUnlinking(false);
        await router.invalidate();
    };
    const closeLink = () => {
        setLinking(false);
        setIssued(null);
        setRefused(null);
        void router.invalidate();
    };

    return (
        <Section caption={C.title}>
            <SettingRows label={C.title}>
                <SettingRow
                    name={C.account}
                    value={
                        linkedAt === null ? (
                            C.notLinked
                        ) : (
                            <>
                                {C.linkedSince} <Time at={linkedAt} format="day" />
                            </>
                        )
                    }
                    action={
                        linkedAt === null ? (
                            <RowAction tone="pink" onClick={() => setLinking(true)}>
                                {C.link}
                            </RowAction>
                        ) : (
                            <RowAction onClick={() => setUnlinking(true)}>{C.unlink}</RowAction>
                        )
                    }
                />
            </SettingRows>
            <Dialog
                open={linking}
                onClose={closeLink}
                title={C.linkTitle}
                busy={pending}
                actions={
                    <Button tone="pink" pending={pending} onClick={() => void getCode()}>
                        {issued === null ? C.getCode : C.newCode}
                    </Button>
                }
            >
                <Stack gap={3}>
                    <p>{C.how}</p>
                    {issued === null ? null : (
                        <>
                            <Code>{`/link code:${issued.code}`}</Code>
                            <p>
                                {C.expires} <Time at={issued.expiresAt} />
                            </p>
                        </>
                    )}
                    <RefusalNote refused={linking ? refused : null} />
                </Stack>
            </Dialog>
            <Dialog
                open={unlinking}
                onClose={() => {
                    setUnlinking(false);
                    setRefused(null);
                }}
                title={C.unlinkTitle}
                busy={pending}
                actions={
                    <>
                        <Button tone="ghost" disabled={pending} onClick={() => setUnlinking(false)}>
                            {C.cancel}
                        </Button>
                        <Button tone="danger" pending={pending} onClick={() => void unlink()}>
                            {C.unlink}
                        </Button>
                    </>
                }
            >
                <Stack gap={3}>
                    <p>{C.rolesFollow}</p>
                    <RefusalNote refused={unlinking ? refused : null} />
                </Stack>
            </Dialog>
        </Section>
    );
}
