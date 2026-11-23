import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Check } from "../../ui/Check/Check.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { PREFERENCES_COPY, PREFERENCES_TITLE } from "./copy.ts";
import { savePreference, saveSubscription } from "./server.ts";

const route = getRouteApi("/_member/account/preferences");

export function PreferencesPage() {
    const outcome = route.useLoaderData();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const save = async (data: FormData) => {
        const reply = await savePreference({
            data: { kind: "product_status", inbox: data.has("inbox"), mail: data.has("mail") },
        });
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    return (
        <Page title={PREFERENCES_TITLE} width="narrow">
            <RefusalNote refused={outcome.ok ? refused : outcome.refused} />
            {outcome.ok ? (
                <>
                    <Section caption={PREFERENCES_COPY.security}>
                        <p>{PREFERENCES_COPY.required}</p>
                    </Section>
                    <Section caption={PREFERENCES_COPY.status}>
                        <form action={save} key={`${outcome.value.inbox}/${outcome.value.mail}`}>
                            <Stack gap={2}>
                                <Check
                                    name="inbox"
                                    label={PREFERENCES_COPY.inbox}
                                    defaultChecked={outcome.value.inbox}
                                />
                                <Check
                                    name="mail"
                                    label={PREFERENCES_COPY.mail}
                                    defaultChecked={outcome.value.mail}
                                />
                                <Button type="submit">{PREFERENCES_COPY.save}</Button>
                            </Stack>
                        </form>
                    </Section>
                    <Section caption={PREFERENCES_COPY.follows}>
                        <Stack gap={2}>
                            {outcome.value.products.map(({ productId, name, following }) => (
                                <Button
                                    key={productId}
                                    onClick={async () => {
                                        const reply = await saveSubscription({
                                            data: { productId, following: !following },
                                        });
                                        setRefused(reply.ok ? null : reply.refused);
                                        if (reply.ok) await router.invalidate();
                                    }}
                                >
                                    {following
                                        ? PREFERENCES_COPY.unfollow(name.toLowerCase())
                                        : PREFERENCES_COPY.follow(name.toLowerCase())}
                                </Button>
                            ))}
                        </Stack>
                    </Section>
                </>
            ) : null}
        </Page>
    );
}
