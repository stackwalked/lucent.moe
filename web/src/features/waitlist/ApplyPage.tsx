import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { BarePage } from "../../ui/BarePage/BarePage.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { WAITLIST_COPY } from "./copy.ts";
import { submitApplication } from "./server.ts";

function answer(form: FormData, name: string): string {
    return String(form.get(name) ?? "").trim();
}

function optional(form: FormData, name: string): string | null {
    const value = answer(form, name);
    return value === "" ? null : value;
}

// The waitlist's form. Whatever the address or the member named, the answer reads the same: it
// never says whether someone already has an account, an application or such a username.
export function ApplyPage() {
    const [sent, setSent] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);

    const submit = async (form: FormData) => {
        const reply = await submitApplication({
            data: {
                email: answer(form, "email"),
                discord: answer(form, "discord"),
                experience: answer(form, "experience"),
                games: answer(form, "games"),
                knownBy: optional(form, "knownBy"),
                additional: optional(form, "additional"),
            },
        });
        if (!reply.ok) {
            setRefused(reply.refused);
            return;
        }
        setRefused(null);
        setSent(true);
    };

    return (
        <BarePage title={WAITLIST_COPY.title}>
            <Stack gap={4}>
                {sent ? (
                    <p role="status">{WAITLIST_COPY.sent}</p>
                ) : (
                    <form action={submit}>
                        <Stack gap={4}>
                            <TextField
                                name="email"
                                label={WAITLIST_COPY.email}
                                type="email"
                                required
                                maxLength={254}
                                autoComplete="email"
                            />
                            <TextField
                                name="discord"
                                label={WAITLIST_COPY.discord}
                                required
                                minLength={2}
                                maxLength={32}
                                autoComplete="off"
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
