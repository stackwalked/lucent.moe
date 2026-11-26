import { getRouteApi } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Pager } from "../../../ui/Pager/Pager.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { productName } from "../../products/view.ts";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { ListRefusal } from "../ListRefusal.tsx";
import { useListNavigation } from "../list.ts";
import { ADMIN_CLOUD_COPY as C } from "./copy.ts";
import { approveListing, removeListing } from "./server.ts";
import { ADMIN_CLOUD_TITLE } from "./title.ts";

const route = getRouteApi("/_admin/admin/cloud/listings");

// Bare for now: what waits for approval, oldest first, with approve and remove. Reported
// listings are in moderation with everything else reported.
export function AdminCloudPage() {
    const outcome = route.useLoaderData();
    const navigation = useListNavigation();
    return (
        <Page title={ADMIN_CLOUD_TITLE}>
            {!outcome.ok ? (
                <ListRefusal refused={outcome.refused} />
            ) : outcome.value.items.length === 0 ? (
                <Empty>{C.none}</Empty>
            ) : (
                <Stack gap={4}>
                    <Table
                        caption={C.table}
                        rows={outcome.value.items}
                        rowKey={(row) => row.id}
                        columns={[
                            {
                                key: "owner",
                                header: C.owner,
                                cell: (row) => (
                                    <Who
                                        accountId={row.owner.accountId}
                                        username={row.owner.username}
                                        pending={ADMIN_COPY.pending}
                                    />
                                ),
                            },
                            {
                                key: "product",
                                header: C.product,
                                cell: (row) => productName(row.productId),
                            },
                            { key: "kind", header: C.kind, cell: (row) => row.kind },
                            { key: "name", header: C.name, cell: (row) => row.name },
                            { key: "summary", header: C.summary, cell: (row) => row.summary },
                            {
                                key: "what",
                                header: C.what,
                                cell: (row) => (row.first ? C.first : C.update),
                            },
                            {
                                key: "actions",
                                header: "",
                                cell: (row) => (
                                    <Stack direction="row" gap={2}>
                                        <AccountAction
                                            action="moderation:remove"
                                            label={C.approve}
                                            title={C.approveTitle}
                                            icon="check"
                                            fields={<p>{C.approveBody}</p>}
                                            run={() =>
                                                approveListing({ data: { listingId: row.id } })
                                            }
                                        />
                                        <AccountAction
                                            action="moderation:remove"
                                            label={C.remove}
                                            title={C.removeTitle}
                                            tone="danger"
                                            icon="trash-2"
                                            fields={<p>{C.removeBody}</p>}
                                            run={() =>
                                                removeListing({ data: { listingId: row.id } })
                                            }
                                        />
                                    </Stack>
                                ),
                            },
                        ]}
                    />
                    <Pager
                        nextCursor={outcome.value.nextCursor}
                        onNext={(cursor) => void navigation.next(cursor)}
                    />
                </Stack>
            )}
        </Page>
    );
}
