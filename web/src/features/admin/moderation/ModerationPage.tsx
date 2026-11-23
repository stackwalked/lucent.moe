import { getRouteApi } from "@tanstack/react-router";
import { Page } from "../../../ui/Page/Page.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { MODERATION_COPY } from "./copy.ts";
import { RestrictionsSection } from "./RestrictionsSection.tsx";

const route = getRouteApi("/_admin/admin/moderation");

export function ModerationPage() {
    const { restrictions } = route.useLoaderData();
    return (
        <Page title={MODERATION_COPY.title}>
            <Stack gap={6}>
                <RestrictionsSection outcome={restrictions} />
            </Stack>
        </Page>
    );
}
