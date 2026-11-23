import type { Outcome } from "../../../server/outcome.ts";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Pager } from "../../../ui/Pager/Pager.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { ListRefusal } from "../ListRefusal.tsx";
import { useListNavigation } from "../list.ts";
import { MODERATION_COPY } from "./copy.ts";
import { type listReports, resolveReport } from "./server.ts";

type Listed = Extract<Awaited<ReturnType<typeof listReports>>, { ok: true }>["value"];

export function ReportsSection({ outcome }: { readonly outcome: Outcome<Listed> }) {
    const navigation = useListNavigation();
    return (
        <Section caption={MODERATION_COPY.reports}>
            {!outcome.ok ? (
                <ListRefusal refused={outcome.refused} />
            ) : outcome.value.items.length === 0 ? (
                <Empty>{MODERATION_COPY.noReports}</Empty>
            ) : (
                <Stack gap={4}>
                    <Table
                        caption={MODERATION_COPY.reportsTable}
                        rows={outcome.value.items}
                        rowKey={(row) => row.id}
                        columns={[
                            {
                                key: "time",
                                header: MODERATION_COPY.reported,
                                cell: (row) => <Time at={row.createdAt} format="relative" />,
                            },
                            {
                                key: "content",
                                header: MODERATION_COPY.content,
                                cell: (row) => `${MODERATION_COPY[row.kind]}: ${row.excerpt}`,
                            },
                            {
                                key: "author",
                                header: MODERATION_COPY.written,
                                cell: (row) => (
                                    <Who
                                        accountId={row.author.accountId}
                                        username={row.author.username}
                                        pending={ADMIN_COPY.pending}
                                    />
                                ),
                            },
                            {
                                key: "reason",
                                header: MODERATION_COPY.reason,
                                cell: (row) =>
                                    row.note === ""
                                        ? MODERATION_COPY[row.reason]
                                        : `${MODERATION_COPY[row.reason]}: ${row.note}`,
                            },
                            {
                                key: "reporter",
                                header: MODERATION_COPY.reporter,
                                cell: (row) => row.reporter.username ?? ADMIN_COPY.pending,
                            },
                            {
                                key: "actions",
                                header: "",
                                cell: (row) => (
                                    <Stack direction="row" gap={2}>
                                        <AccountAction
                                            action="moderation:remove"
                                            label={MODERATION_COPY.remove}
                                            title={MODERATION_COPY.removeTitle}
                                            tone="danger"
                                            icon="trash-2"
                                            fields={<p>{MODERATION_COPY.removeBody}</p>}
                                            run={() =>
                                                resolveReport({
                                                    data: { id: row.id, outcome: "remove" },
                                                })
                                            }
                                        />
                                        <AccountAction
                                            action="moderation:remove"
                                            label={MODERATION_COPY.dismiss}
                                            title={MODERATION_COPY.dismissTitle}
                                            icon="check"
                                            fields={<p>{MODERATION_COPY.dismissBody}</p>}
                                            run={() =>
                                                resolveReport({
                                                    data: { id: row.id, outcome: "dismiss" },
                                                })
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
        </Section>
    );
}
