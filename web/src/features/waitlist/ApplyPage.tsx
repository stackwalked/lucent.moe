import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { BarePage } from "../../ui/BarePage/BarePage.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { beginDiscordLink } from "../discord/server.ts";
import { WAITLIST_COPY } from "./copy.ts";
import { submitApplication } from "./server.ts";

const route = getRouteApi("/_public/apply");

function answer(form: FormData, name: string): string {
    return String(form.get(name) ?? "").trim();
}

function optional(form: FormData, name: string): string | null {
    const value = answer(form, name);
    return value === "" ? null : value;
}

const LINK_FAILED: Refused = { code: "DISCORD_LINK_FAILED", reference: null };

// The waitlist's form. Whatever the address or the member named, the answer reads the same: it
// never says whether someone already has an account, an application or such a username. Where
// Discord is configured the form waits for the applicant to link it, which also joins them to the
// guild.
export function ApplyPage() {
    const router = useRouter();
    const { discordRequired, discordUsername } = route.useLoaderData();
    const { discord } = route.useSearch();
    const [sent, setSent] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    const [linking, setLinking] = useState(false);

    const submit = async (form: FormData) => {
        const reply = await submitApplication({
            data: {
                email: answer(form, "email"),
                experience: answer(form, "experience"),
                games: answer(form, "games"),
                knownBy: optional(form, "knownBy"),
                additional: optional(form, "additional"),
            },
        });
        if (!reply.ok) {
            setRefused(reply.refused);
            if (reply.refused.code === "DISCORD_LINK_REQUIRED") await router.invalidate();
            return;
        }
        setRefused(null);
        setSent(true);
    };

    const linkDiscord = async () => {
        setLinking(true);
        const reply = await beginDiscordLink({ data: { for: "apply" } });
        if (reply.ok) {
            window.location.assign(reply.value.url);
            return;
        }
        setLinking(false);
        setRefused(reply.refused);
    };

    if (!sent && discordRequired && discordUsername === null) {
        return (
            <BarePage title={WAITLIST_COPY.title}>
                <Stack gap={4}>
                    <div>
                        <Button tone="pink" pending={linking} onClick={() => void linkDiscord()}>
                            {WAITLIST_COPY.linkDiscord}
                        </Button>
                    </div>
                    <p>{WAITLIST_COPY.joins}</p>
                    <RefusalNote refused={refused ?? (discord === "failed" ? LINK_FAILED : null)} />
                </Stack>
            </BarePage>
        );
    }

    return (
        <BarePage title={WAITLIST_COPY.title}>
            <Stack gap={4}>
                {sent ? (
                    <p role="status">{WAITLIST_COPY.sent}</p>
                ) : (
                    <form action={submit}>
                        <Stack gap={4}>
                            {discordUsername === null ? null : (
                                <Pairs
                                    items={[
                                        { label: WAITLIST_COPY.discord, value: discordUsername },
                                    ]}
                                />
                            )}
                            <TextField
                                name="email"
                                label={WAITLIST_COPY.email}
                                type="email"
                                required
                                maxLength={254}
                                autoComplete="email"
                            />
                            <TextArea
                                name="experience"
                                label={WAITLIST_COPY.experience}
                                size="grow"
                                maxLength={1000}
                                required
                            />
                            <TextArea
                                name="games"
                                label={WAITLIST_COPY.games}
                                size="grow"
                                maxLength={300}
                                required
                            />
                            <TextField
                                name="knownBy"
                                label={WAITLIST_COPY.knownBy}
                                maxLength={64}
                                autoComplete="off"
                            />
                            <TextArea
                                name="additional"
                                label={WAITLIST_COPY.additional}
                                hint={WAITLIST_COPY.additionalHint}
                                size="grow"
                                maxLength={1000}
                            />
                            <RefusalNote refused={refused} />
                            <div>
                                <Button type="submit">{WAITLIST_COPY.submit}</Button>
                            </div>
                        </Stack>
                    </form>
                )}
            </Stack>
        </BarePage>
    );
}
