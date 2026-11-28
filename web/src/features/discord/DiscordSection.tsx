import type { EpochMs } from "@lucent/core/brands";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { RowAction, SettingRow, SettingRows } from "../../ui/SettingRow/SettingRow.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { DISCORD_COPY as C } from "./copy.ts";
import { beginDiscordLink, removeDiscordLink } from "./server.ts";

const route = getRouteApi("/_member/account/");

const AFTER_LINK: { readonly [K in "failed" | "taken"]: Refused } = {
    failed: { code: "DISCORD_LINK_FAILED", reference: null },
    taken: { code: "ALREADY_LINKED", reference: null },
};

// Linking goes to Discord and comes back to /discord/callback, which links the account and joins
// the member to the guild; the page then shows the result in its search. It is offered only where
// the site has a Discord application.
export function DiscordSection({
    link,
    configured,
}: {
    readonly link: Outcome<{ readonly linkedAt: EpochMs | null }>;
    readonly configured: boolean;
}) {
    const router = useRouter();
    const { discord } = route.useSearch();
    const [linking, setLinking] = useState(false);
    const [unlinking, setUnlinking] = useState(false);
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

    const continueToDiscord = async () => {
        setPending(true);
        const reply = await beginDiscordLink({ data: { for: "account" } });
        if (reply.ok) {
            window.location.assign(reply.value.url);
            return;
        }
        setPending(false);
        setRefused(reply.refused);
    };
    const unlink = async () => {
        setPending(true);
        const reply = await removeDiscordLink();
        setPending(false);
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) setUnlinking(false);
        await router.invalidate();
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
                        linkedAt !== null ? (
                            <RowAction onClick={() => setUnlinking(true)}>{C.unlink}</RowAction>
                        ) : configured ? (
                            <RowAction tone="pink" onClick={() => setLinking(true)}>
                                {C.link}
                            </RowAction>
                        ) : undefined
                    }
                />
            </SettingRows>
            <RefusalNote refused={discord === undefined ? null : AFTER_LINK[discord]} />
            <Dialog
                open={linking}
                onClose={() => {
                    setLinking(false);
                    setRefused(null);
                }}
                title={C.linkTitle}
                busy={pending}
                actions={
                    <Button tone="pink" pending={pending} onClick={() => void continueToDiscord()}>
                        {C.continue}
                    </Button>
                }
            >
                <Stack gap={3}>
                    <p>{C.joins}</p>
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
