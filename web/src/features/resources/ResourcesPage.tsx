import { getRouteApi } from "@tanstack/react-router";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { RESOURCES_COPY, RESOURCES_TITLE, sizeText } from "./copy.ts";
import { downloadPath } from "./download.ts";

const route = getRouteApi("/_member/resources");

// Files staff published: those for every member, and those for the products the member holds.
export function ResourcesPage() {
    const outcome = route.useLoaderData();
    return (
        <Page title={RESOURCES_TITLE}>
            {!outcome.ok ? (
                <RefusalNote refused={outcome.refused} />
            ) : outcome.value.length === 0 ? (
                <Empty>{RESOURCES_COPY.none}</Empty>
            ) : (
                <Table
                    caption={RESOURCES_TITLE}
                    rows={outcome.value}
                    rowKey={(resource) => resource.id}
                    columns={[
                        {
                            key: "title",
                            header: RESOURCES_COPY.title,
                            cell: (resource) => (
                                <Stack gap={1}>
                                    <span>{resource.title}</span>
                                    {resource.description === "" ? null : (
                                        <span>{resource.description}</span>
                                    )}
                                </Stack>
                            ),
                        },
                        {
                            key: "product",
                            header: RESOURCES_COPY.product,
                            cell: (resource) => resource.productId ?? RESOURCES_COPY.everyone,
                        },
                        {
                            key: "size",
                            header: RESOURCES_COPY.size,
                            cell: (resource) => sizeText(resource.size),
                        },
                        {
                            key: "updated",
                            header: RESOURCES_COPY.updated,
                            cell: (resource) => <Time at={resource.updatedAt} />,
                        },
                        {
                            key: "download",
                            header: "",
                            align: "end",
                            cell: (resource) => (
                                <form method="get" action={downloadPath(resource.id)}>
                                    <Button
                                        size="sm"
                                        type="submit"
                                        label={RESOURCES_COPY.downloadTitle(resource.title)}
                                    >
                                        {RESOURCES_COPY.download}
                                    </Button>
                                </form>
                            ),
                        },
                    ]}
                />
            )}
        </Page>
    );
}
