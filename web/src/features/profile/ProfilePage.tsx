import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { postingNote } from "../comments/posting.ts";
import { TextArea } from "../comments/TextArea.tsx";
import { blockAccount } from "../privacy/server.ts";
import { PROFILE_COPY } from "./copy.ts";
import { saveBio } from "./server.ts";
import { PROFILE_TITLE } from "./title.ts";

const route = getRouteApi("/_member/members/$username");

export function ProfilePage() {
    const outcome = route.useLoaderData();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const save = async (form: FormData) => {
        const reply = await saveBio({ data: { bio: String(form.get("bio") ?? "") } });
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    if (!outcome.ok) {
        return (
            <Page title={PROFILE_TITLE} width="narrow">
                <RefusalNote refused={outcome.refused} />
            </Page>
        );
    }
    const profile = outcome.value;
    const note = postingNote(refused);
    return (
        <Page title={profile.username} width="narrow">
            <Stack gap={6}>
                <Pairs
                    items={[
                        {
                            label: PROFILE_COPY.joined,
                            value: <Time at={profile.joinedAt} />,
                        },
                    ]}
                />
                <p>{profile.bio === "" ? PROFILE_COPY.noBio : profile.bio}</p>
                {profile.isSelf ? null : (
                    <div>
                        <Button
                            tone="danger"
                            onClick={async () => {
                                const reply = await blockAccount({
                                    data: { username: profile.username, blocked: true },
                                });
                                if (!reply.ok) return setRefused(reply.refused);
                                await router.navigate({ to: "/account/privacy" });
                            }}
                        >
                            {PROFILE_COPY.block}
                        </Button>
                    </div>
                )}
                {profile.isSelf ? (
                    <Section caption={PROFILE_COPY.edit}>
                        <form action={save} key={profile.bio}>
                            <Stack gap={3}>
                                <RefusalNote
                                    refused={refused}
                                    {...(note === undefined ? {} : { extra: note })}
                                />
                                <TextArea
                                    name="bio"
                                    label={PROFILE_COPY.bio}
                                    maxLength={500}
                                    defaultValue={profile.bio}
                                />
                                <div>
                                    <Button type="submit">{PROFILE_COPY.save}</Button>
                                </div>
                            </Stack>
                        </form>
                    </Section>
                ) : null}
            </Stack>
        </Page>
    );
}
