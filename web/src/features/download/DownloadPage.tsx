import { getRouteApi } from "@tanstack/react-router";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { DOWNLOAD_COPY } from "./copy.ts";

const route = getRouteApi("/_member/download");

const LOADER_PRODUCT = "lucent-loader";

type Loaded = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Channel = Loaded[number]["channels"][number];

// The loader for the channels the member holds it on, and what Windows will make of a binary
// with no Authenticode signature. The files themselves need platform's download route, which
// doesn't exist yet: until it does, each channel says when its loader was released and nothing
// is offered.
export function DownloadPage() {
    const loaded = route.useLoaderData();
    if (!loaded.ok) {
        return (
            <Page title={DOWNLOAD_COPY.title} width="narrow">
                <RefusalNote refused={loaded.refused} />
            </Page>
        );
    }
    const channels = loaded.value.find((p) => p.productId === LOADER_PRODUCT)?.channels ?? [];
    return (
        <Page title={DOWNLOAD_COPY.title} width="narrow">
            <Section caption={DOWNLOAD_COPY.channels}>
                <Stack gap={3}>
                    <p>{DOWNLOAD_COPY.intro}</p>
                    {channels.length === 0 ? (
                        <Empty>{DOWNLOAD_COPY.none}</Empty>
                    ) : (
                        <Table
                            caption={DOWNLOAD_COPY.channels}
                            columns={[
                                {
                                    key: "channel",
                                    header: DOWNLOAD_COPY.channel,
                                    cell: (c: Channel) => c.channel,
                                },
                                {
                                    key: "released",
                                    header: DOWNLOAD_COPY.released,
                                    align: "end",
                                    cell: (c) =>
                                        c.release === null ? (
                                            <Status>{DOWNLOAD_COPY.notOut}</Status>
                                        ) : (
                                            <Time at={c.release.promotedAt} />
                                        ),
                                },
                            ]}
                            rows={channels}
                            rowKey={(c) => c.channel}
                        />
                    )}
                    <p>{DOWNLOAD_COPY.unavailable}</p>
                </Stack>
            </Section>
            <Section caption={DOWNLOAD_COPY.warnings}>
                <Stack gap={2}>
                    <p>{DOWNLOAD_COPY.unsigned}</p>
                    <p>{DOWNLOAD_COPY.smartScreen}</p>
                    <p>{DOWNLOAD_COPY.antivirus}</p>
                    <p>{DOWNLOAD_COPY.onlyHere}</p>
                </Stack>
            </Section>
        </Page>
    );
}
