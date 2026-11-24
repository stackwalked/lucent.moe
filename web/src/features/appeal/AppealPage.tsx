import { getRouteApi, useRouter } from "@tanstack/react-router";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { forgetSession } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { signOut } from "../auth/session.ts";
import { Reply, Thread } from "../tickets/Thread.tsx";
import { APPEAL_COPY, APPEAL_TITLE } from "./copy.ts";
import { sendAppeal } from "./server.ts";

const route = getRouteApi("/_auth/appeal");

// What a suspended account sees after signing in: why it was suspended, as staff recorded it, and
// its appeal to staff. Nothing else is reachable from here.
export function AppealPage() {
    const outcome = route.useLoaderData();
    const router = useRouter();
    const leave = (
        <Button
            size="sm"
            tone="ghost"
            onClick={async () => {
                await signOut();
                forgetSession();
                await router.navigate({ to: "/sign-in" });
            }}
        >
            {APPEAL_COPY.signOut}
        </Button>
    );
    if (!outcome.ok) {
        return (
            <Page title={APPEAL_TITLE} actions={leave}>
                <RefusalNote refused={outcome.refused} />
            </Page>
        );
    }
    const { suspension, appeal } = outcome.value;
    return (
        <Page title={APPEAL_TITLE} actions={leave} width="narrow">
            <Stack gap={6}>
                <p>{APPEAL_COPY.suspended}</p>
                <Pairs
                    items={[
                        {
                            label: APPEAL_COPY.reason,
                            value: suspension?.reason ?? APPEAL_COPY.noReason,
                        },
                        ...(suspension === null
                            ? []
                            : [{ label: APPEAL_COPY.since, value: <Time at={suspension.at} /> }]),
                    ]}
                />
                <Section caption={APPEAL_COPY.thread}>
                    <Stack gap={4}>
                        {appeal === null ? (
                            <Empty>{APPEAL_COPY.none}</Empty>
                        ) : (
                            <>
                                <Status tone={appeal.state === "answered" ? "pink" : "neutral"}>
                                    {APPEAL_COPY.states[appeal.state]}
                                </Status>
                                <Thread caption={APPEAL_COPY.thread} messages={appeal.messages} />
                            </>
                        )}
                        <Reply
                            label={appeal === null ? APPEAL_COPY.first : APPEAL_COPY.more}
                            submitLabel={APPEAL_COPY.send}
                            send={(body) => sendAppeal({ data: { body } })}
                        />
                    </Stack>
                </Section>
                <p>{APPEAL_COPY.window}</p>
            </Stack>
        </Page>
    );
}
