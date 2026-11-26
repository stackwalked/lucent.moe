import { getRouteApi } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { productName } from "../products/view.ts";
import { Notes, SnapshotPage } from "../status/Record.tsx";
import { CHANGELOG_COPY as C } from "./copy.ts";

const route = getRouteApi("/_member/changelog");

// What changed, newest first: the service's entries and every listed product's.
export function ChangelogPage() {
    const snapshot = route.useLoaderData();
    return (
        <Page title={C.title} width="narrow">
            <SnapshotPage snapshot={snapshot}>
                {({ entries, names }) => {
                    if (entries.length === 0) return <Empty>{C.none}</Empty>;
                    const named = new Map<string, string>(
                        names.map((p) => [p.id, productName(p.name)]),
                    );
                    return (
                        <Notes
                            notes={entries}
                            meta={(entry) => (
                                <>
                                    {entry.productId === null
                                        ? SITE_COPY.name
                                        : (named.get(entry.productId) ?? entry.productId)}{" "}
                                    · <Time at={entry.publishedAt} />
                                </>
                            )}
                        />
                    );
                }}
            </SnapshotPage>
        </Page>
    );
}
