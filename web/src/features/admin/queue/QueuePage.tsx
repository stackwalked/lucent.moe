import { systemClock } from "@lucent/core/clock";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useContext, useState } from "react";
import { Button } from "../../../ui/Button/Button.tsx";
import { Columns } from "../../../ui/Columns/Columns.tsx";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page, PageTabsContext } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { productName, productNamer, statusWord } from "../../products/view.ts";
import { ADMIN_COPY, operationLabel } from "../copy.ts";
import { QUEUE_COPY as C } from "./copy.ts";
import { mergeQueue, type QueueKind, type QueueRow, waitedLong } from "./merge.ts";
import styles from "./QueuePage.module.css";
import { applicationRows, flagRows, listingRows, reportRows, ticketRows } from "./rows.ts";
import { fetchQueue, type Queue } from "./server.ts";

const route = getRouteApi("/_admin/admin/");

type Cursors = { tickets: string | null; reports: string | null; listings: string | null };

function RowLink({ row }: { readonly row: QueueRow }) {
    const text = (
        <>
            <span className={styles.title}>{row.title}</span>
            <span className={styles.context}>{row.context}</span>
        </>
    );
    switch (row.kind) {
        case "tickets":
            return (
                <Link
                    to="/admin/queue/tickets/$ticketId"
                    params={{ ticketId: row.id }}
                    search={{ from: "all" }}
                    className={styles.open}
                >
                    {text}
                </Link>
            );
        case "applications":
            return (
                <Link
                    to="/admin/queue/applications/$applicationId"
                    params={{ applicationId: row.id }}
                    search={{ from: "all" }}
                    className={styles.open}
                >
                    {text}
                </Link>
            );
        case "reports":
            return (
                <Link to="/admin/queue/reports" className={styles.open}>
                    {text}
                </Link>
            );
        case "flags":
            return (
                <Link to="/admin/queue/flags" className={styles.open}>
                    {text}
                </Link>
            );
        case "listings":
            return (
                <Link to="/admin/cloud/listings" className={styles.open}>
                    {text}
                </Link>
            );
    }
}

function cursorsOf(queue: Queue): Cursors {
    return {
        tickets: queue.tickets?.ok ? queue.tickets.value.nextCursor : null,
        reports: queue.reports?.ok ? queue.reports.value.nextCursor : null,
        listings: queue.listings?.ok ? queue.listings.value.nextCursor : null,
    };
}

// Everything waiting for staff, oldest first. Each read pages on its own, so only what has been
// loaded is merged: "more" loads the next page of every read that has one.
export function QueuePage() {
    const { queue, catalog, products, system, audit, kinds } = route.useLoaderData();
    const subTabs = useContext(PageTabsContext);
    const nameOf = productNamer(catalog);
    const [parts, setParts] = useState<Partial<Record<QueueKind, readonly QueueRow[]>>>(() => ({
        tickets: queue.tickets?.ok ? ticketRows(queue.tickets.value, nameOf) : [],
        applications: queue.applications?.ok ? applicationRows(queue.applications.value) : [],
        reports: queue.reports?.ok ? reportRows(queue.reports.value) : [],
        flags: queue.flags?.ok ? flagRows(queue.flags.value) : [],
        listings: queue.listings?.ok ? listingRows(queue.listings.value, nameOf) : [],
    }));
    const [cursors, setCursors] = useState<Cursors>(() => cursorsOf(queue));
    const [pending, setPending] = useState(false);
    const rows = mergeQueue(parts);
    const more = cursors.tickets !== null || cursors.reports !== null || cursors.listings !== null;
    const now = systemClock.now();

    const loadMore = async () => {
        setPending(true);
        const next = await fetchQueue({ data: { kinds: [...kinds], cursors } });
        setPending(false);
        setParts((soFar) => ({
            ...soFar,
            tickets: [
                ...(soFar.tickets ?? []),
                ...(cursors.tickets !== null && next.tickets?.ok
                    ? ticketRows(next.tickets.value, nameOf)
                    : []),
            ],
            reports: [
                ...(soFar.reports ?? []),
                ...(cursors.reports !== null && next.reports?.ok
                    ? reportRows(next.reports.value)
                    : []),
            ],
            listings: [
                ...(soFar.listings ?? []),
                ...(cursors.listings !== null && next.listings?.ok
                    ? listingRows(next.listings.value, nameOf)
                    : []),
            ],
        }));
        setCursors({
            tickets:
                cursors.tickets !== null && next.tickets?.ok ? next.tickets.value.nextCursor : null,
            reports:
                cursors.reports !== null && next.reports?.ok ? next.reports.value.nextCursor : null,
            listings:
                cursors.listings !== null && next.listings?.ok
                    ? next.listings.value.nextCursor
                    : null,
        });
    };

    const failing = system?.ok ? system.value.jobs.some((job) => job.failed) : null;
    const discordJob = system?.ok
        ? system.value.jobs.find((job) => job.name.toLowerCase().includes("discord"))
        : undefined;
    const newest = audit?.ok ? audit.value.items.slice(0, 5) : [];
    const listed = products.ok ? products.value.filter((p) => p.productId !== "loader") : [];

    return (
        <Page title={ADMIN_COPY.tabs.queue} hideTitle tabs={null}>
            <Columns
                head={{ lead: subTabs }}
                main={
                    rows.length === 0 ? (
                        <Empty>{C.none}</Empty>
                    ) : (
                        <>
                            <ul className={styles.rows}>
                                {rows.map((row) => (
                                    <li key={`${row.kind}-${row.id}`} className={styles.row}>
                                        <span className={styles.kind}>{C.kinds[row.kind]}</span>
                                        <RowLink row={row} />
                                        <span className={styles.who}>
                                            {row.who === null ? null : row.who.username ===
                                              null ? null : (
                                                <Link
                                                    to="/admin/members/accounts/$accountId"
                                                    params={{ accountId: row.who.accountId }}
                                                    className={styles.account}
                                                >
                                                    {row.who.username}
                                                </Link>
                                            )}
                                        </span>
                                        <span
                                            className={styles.age}
                                            data-long={waitedLong(row.at, now)}
                                        >
                                            <Time at={row.at} format="relative" />
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            {more ? (
                                <div>
                                    <Button type="button" pending={pending} onClick={loadMore}>
                                        {C.more}
                                    </Button>
                                </div>
                            ) : null}
                        </>
                    )
                }
                aside={
                    <>
                        {listed.length === 0 ? null : (
                            <Section caption={C.products}>
                                <ul className={styles.side}>
                                    {listed.map((product) => {
                                        const word = statusWord(product.state, null);
                                        return (
                                            <li key={product.productId} className={styles.sideRow}>
                                                <span>{productName(product.name)}</span>
                                                {word === null ? null : (
                                                    <span
                                                        className={styles.word}
                                                        data-tone={word.tone}
                                                    >
                                                        {word.word}
                                                    </span>
                                                )}
                                                <Link
                                                    to="/admin/products/status"
                                                    className={styles.set}
                                                >
                                                    {C.set}
                                                </Link>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </Section>
                        )}
                        {failing === null ? null : (
                            <Section caption={C.system}>
                                <ul className={styles.side}>
                                    <li className={styles.sideRow}>
                                        <span>{C.jobs}</span>
                                        <span
                                            className={styles.word}
                                            data-tone={failing ? "shu" : "ok"}
                                        >
                                            {failing ? C.failing : C.ok}
                                        </span>
                                    </li>
                                    {system?.ok ? (
                                        <li className={styles.sideRow}>
                                            <span>{C.mail}</span>
                                            <span
                                                className={styles.word}
                                                data-tone={
                                                    system.value.mail.pending > 0 ? "wait" : "ok"
                                                }
                                            >
                                                {system.value.mail.pending > 0
                                                    ? C.waiting
                                                    : C.clear}
                                            </span>
                                        </li>
                                    ) : null}
                                    {discordJob === undefined ? null : (
                                        <li className={styles.sideRow}>
                                            <span>{C.discord}</span>
                                            <span
                                                className={styles.word}
                                                data-tone={discordJob.failed ? "shu" : "ok"}
                                            >
                                                {discordJob.failed ? C.failing : C.ok}
                                            </span>
                                        </li>
                                    )}
                                </ul>
                            </Section>
                        )}
                        {newest.length === 0 ? null : (
                            <Section caption={C.recent}>
                                <ul className={styles.side}>
                                    {newest.map((entry) => (
                                        <li key={entry.id} className={styles.sideRow}>
                                            <span className={styles.line}>
                                                {operationLabel(entry.operation)}
                                            </span>
                                            <span className={styles.word}>
                                                <Time at={entry.at} format="relative" />
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </Section>
                        )}
                        {queue.tickets !== null && !queue.tickets.ok ? (
                            <RefusalNote refused={queue.tickets.refused} />
                        ) : null}
                    </>
                }
            />
        </Page>
    );
}
