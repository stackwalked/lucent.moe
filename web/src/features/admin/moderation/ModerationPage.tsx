import { getRouteApi } from "@tanstack/react-router";
import { Page } from "../../../ui/Page/Page.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { RestrictionsSection } from "./RestrictionsSection.tsx";
import { MODERATION_TITLE } from "./title.ts";

const route = getRouteApi("/_admin/admin/moderation");

export function ModerationPage() {
    const { restrictions } = route.useLoaderData();
    return (
        <Page title={MODERATION_TITLE}>
            <Stack gap={6}>
                <RestrictionsSection outcome={restrictions} />
            </Stack>
        </Page>
    );
}
