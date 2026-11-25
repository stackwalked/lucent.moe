import type { EpochMs } from "@lucent/core/brands";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Code } from "../../ui/Code/Code.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { DISCORD_COPY as C, DISCORD_TITLE } from "./copy.ts";
import { removeDiscordLink, startDiscordLink } from "./server.ts";

const route = getRouteApi("/_member/account/discord");

type Issued = { readonly code: string; readonly expiresAt: EpochMs };

// Linking starts here and ends in Discord: the code goes to the bot's /link, which is how the
// service learns which Discord user is this account. Nothing is linked until the bot has it.
export function DiscordPage() {
    const outcome = route.useLoaderData();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const [issued, setIssued] = useState<Issued | null>(null);
    const [pending, setPending] = useState(false);

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
        setIssued(null);
        await router.invalidate();
    };

    return (
        <Page title={DISCORD_TITLE} width="narrow">
            <RefusalNote refused={outcome.ok ? refused : outcome.refused} />
            {outcome.ok && outcome.value.linkedAt !== null ? (
                <Section caption={C.linked}>
                    <Stack gap={3}>
                        <Pairs
                            items={[
                                { label: C.linkedAt, value: <Time at={outcome.value.linkedAt} /> },
                            ]}
                        />
                        <p>{C.rolesFollow}</p>
                        <p>
                            {C.notices} <Link to="/account/preferences">{C.preferences}</Link>
                        </p>
                        <div>
                            <Button tone="danger" pending={pending} onClick={unlink}>
                                {C.unlink}
                            </Button>
                        </div>
                    </Stack>
                </Section>
            ) : null}
            {outcome.ok && outcome.value.linkedAt === null ? (
                <Section caption={C.link}>
                    <Stack gap={3}>
                        <p>{C.how}</p>
                        {issued === null ? null : (
                            <>
                                <Code>{`/link code:${issued.code}`}</Code>
                                <Pairs
                                    items={[
                                        { label: C.expires, value: <Time at={issued.expiresAt} /> },
                                    ]}
                                />
                            </>
                        )}
                        <div>
                            <Button
                                tone={issued === null ? "pink" : "plain"}
                                pending={pending}
                                onClick={getCode}
                            >
                                {issued === null ? C.getCode : C.newCode}
                            </Button>
                        </div>
                    </Stack>
                </Section>
            ) : null}
        </Page>
    );
}
