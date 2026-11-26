import { getRouteApi } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { REVIEW_COPY } from "./copy.ts";
import { decideReview } from "./decide.ts";

const route = getRouteApi("/_admin/admin/queue/flags");

type Listed = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Item = Listed["open"][number];
type Signal = Item["signals"][number];

function kindLabel(kind: string): string {
    return REVIEW_COPY.kinds[kind] ?? kind;
}

// The risk review queue: what the scoring job opened, most urgent first, and what staff closed.
// A person decides every item; closing one changes nothing on the account.
export function ReviewPage() {
    const listed = route.useLoaderData();
    if (!listed.ok) {
        return (
            <Page title={REVIEW_COPY.title}>
                <RefusalNote refused={listed.refused} />
            </Page>
        );
    }
    const { open, openTruncated, decided, decidedTruncated } = listed.value;
    return (
        <Page title={REVIEW_COPY.title}>
            <Section caption={REVIEW_COPY.open}>
                {openTruncated ? <p>{REVIEW_COPY.truncatedOpen}</p> : null}
                {open.length === 0 ? (
                    <Empty>{REVIEW_COPY.nothingOpen}</Empty>
                ) : (
                    <Table
                        caption={REVIEW_COPY.open}
                        columns={[
                            {
                                key: "account",
                                header: REVIEW_COPY.account,
                                cell: (item: Item) => <Account item={item} />,
                            },
                            { key: "urgency", header: REVIEW_COPY.urgency, cell: (i) => i.urgency },
                            { key: "risk", header: REVIEW_COPY.risk, cell: (i) => i.risk },
                            {
                                key: "signals",
                                header: REVIEW_COPY.signals,
                                cell: (item) => <Signals item={item} />,
                            },
                            {
                                key: "opened",
                                header: REVIEW_COPY.opened,
                                cell: (item) => <Time at={item.openedAt} />,
                            },
                            {
                                key: "actions",
                                header: "",
                                align: "end",
                                cell: (item) => <Decide item={item} />,
                            },
                        ]}
                        rows={open}
                        rowKey={(item) => item.id}
                    />
                )}
            </Section>
            <Section caption={REVIEW_COPY.decided}>
                {decidedTruncated ? <p>{REVIEW_COPY.truncatedDecided}</p> : null}
                {decided.length === 0 ? (
                    <Empty>{REVIEW_COPY.nothingDecided}</Empty>
                ) : (
                    <Table
                        caption={REVIEW_COPY.decided}
                        columns={[
                            {
                                key: "account",
                                header: REVIEW_COPY.account,
                                cell: (item: Item) => <Account item={item} />,
                            },
                            { key: "risk", header: REVIEW_COPY.risk, cell: (i) => i.risk },
                            {
                                key: "outcome",
                                header: REVIEW_COPY.outcome,
                                cell: (item) =>
                                    item.decision === null
                                        ? null
                                        : REVIEW_COPY.outcomes[item.decision.outcome],
                            },
                            {
                                key: "by",
                                header: REVIEW_COPY.by,
                                cell: (item) =>
                                    item.decision === null ? null : (
                                        <Who
                                            accountId={item.decision.by.id}
                                            username={item.decision.by.username}
                                            pending={ADMIN_COPY.pending}
                                        />
                                    ),
                            },
                            {
                                key: "closed",
                                header: REVIEW_COPY.closed,
                                cell: (item) =>
                                    item.decision === null ? null : <Time at={item.decision.at} />,
                            },
                            {
                                key: "note",
                                header: REVIEW_COPY.note,
                                cell: (item) => item.decision?.note ?? null,
                            },
                        ]}
                        rows={decided}
                        rowKey={(item) => item.id}
                    />
                )}
            </Section>
        </Page>
    );
}

function Account({ item }: { readonly item: Item }) {
    return (
        <Who
            accountId={item.account.id}
            username={item.account.username}
            pending={ADMIN_COPY.pending}
        />
    );
}

function Signals({ item }: { readonly item: Item }) {
    return (
        <Stack gap={1}>
            {item.signals.map((signal: Signal) =>
                signal.weight === 0 ? (
                    <span key={signal.kind}>
                        <Status>{kindLabel(signal.kind)}</Status>
                    </span>
                ) : (
                    <span key={signal.kind}>
                        {kindLabel(signal.kind)}, {REVIEW_COPY.seen(signal.sessions)}{" "}
                        <Time at={signal.lastAt} />
                    </span>
                ),
            )}
        </Stack>
    );
}

function Decide({ item }: { readonly item: Item }) {
    const name = item.account.username ?? item.account.id;
    const note = <TextField name="note" label={REVIEW_COPY.note} maxLength={500} />;
    const noteOf = (form: FormData) => {
        const text = String(form.get("note") ?? "").trim();
        return text === "" ? null : text;
    };
    return (
        <Stack direction="row" gap={2} align="center">
            <AccountAction
                action="risk:review"
                label={REVIEW_COPY.dismiss}
                title={REVIEW_COPY.dismissTitle(name)}
                fields={
                    <Stack gap={3}>
                        <p>{REVIEW_COPY.dismissBody}</p>
                        {note}
                    </Stack>
                }
                run={(form) =>
                    decideReview({
                        data: { itemId: item.id, outcome: "no_action", note: noteOf(form) },
                    })
                }
            />
            <AccountAction
                action="risk:review"
                label={REVIEW_COPY.actioned}
                title={REVIEW_COPY.actionedTitle(name)}
                tone="pink"
                fields={
                    <Stack gap={3}>
                        <p>{REVIEW_COPY.actionedBody}</p>
                        {note}
                    </Stack>
                }
                run={(form) =>
                    decideReview({
                        data: { itemId: item.id, outcome: "actioned", note: noteOf(form) },
                    })
                }
            />
        </Stack>
    );
}
