import { getRouteApi } from "@tanstack/react-router";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { DOWNLOAD_COPY } from "./copy.ts";

const route = getRouteApi("/_member/download");

const LOADER_PRODUCT = "lucent-loader";

// The loader is for any member entitled to a product (it has no channels of its own), and what
// Windows will make of a binary with no Authenticode signature. The files themselves need
// platform's download route, which doesn't exist yet: until it does, nothing is offered.
export function DownloadPage() {
    const loaded = route.useLoaderData();
    if (!loaded.ok) {
        return (
            <Page title={DOWNLOAD_COPY.title} width="narrow">
                <RefusalNote refused={loaded.refused} />
            </Page>
        );
    }
    const hasProduct = loaded.value.some((p) => p.productId !== LOADER_PRODUCT);
    return (
        <Page title={DOWNLOAD_COPY.title} width="narrow">
            <Section caption={DOWNLOAD_COPY.loader}>
                {hasProduct ? (
                    <Stack gap={3}>
                        <p>{DOWNLOAD_COPY.intro}</p>
                        <p>{DOWNLOAD_COPY.unavailable}</p>
                    </Stack>
                ) : (
                    <Empty>{DOWNLOAD_COPY.none}</Empty>
                )}
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
