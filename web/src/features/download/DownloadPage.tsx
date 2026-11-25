import { getRouteApi } from "@tanstack/react-router";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { DOWNLOAD_COPY } from "./copy.ts";

const route = getRouteApi("/_member/download");

// The server route that streams the file (routes/download.lucent-loader[.]exe.tsx).
const LOADER_FILE_PATH = "/download/lucent-loader.exe";

type Offer = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];

// The loader is for any member entitled to a product (it has no channels of its own), and what
// Windows will make of a binary with no Authenticode signature. The button is a plain GET form:
// the file streams from platform through web as an attachment.
export function DownloadPage() {
    const loaded = route.useLoaderData();
    if (!loaded.ok) {
        return (
            <Page title={DOWNLOAD_COPY.title} width="narrow">
                <RefusalNote refused={loaded.refused} />
            </Page>
        );
    }
    return (
        <Page title={DOWNLOAD_COPY.title} width="narrow">
            <Section caption={DOWNLOAD_COPY.loader}>
                <Loader offer={loaded.value} />
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

function Loader({ offer }: { readonly offer: Offer }) {
    if (offer.state === "no_product") return <Empty>{DOWNLOAD_COPY.none}</Empty>;
    return (
        <Stack gap={3}>
            {offer.state === "ready" ? (
                <form method="get" action={LOADER_FILE_PATH}>
                    <Button tone="pink" type="submit">
                        {DOWNLOAD_COPY.download}
                    </Button>
                </form>
            ) : (
                <p>{DOWNLOAD_COPY.unavailable}</p>
            )}
        </Stack>
    );
}
