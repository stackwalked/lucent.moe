import { can } from "@lucent/policy/policy";
import { getRouteApi, Link, useRouteContext } from "@tanstack/react-router";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { memberOf, subjectOf } from "../../viewer.ts";
import { ListingRow } from "../cloud/ListingRow.tsx";
import { usePresence } from "../community/presence.ts";
import { LOADER_PRODUCT_ID, productName, statusWord } from "../products/view.ts";
import { SiteShell } from "../shell/SiteShell.tsx";
import { ShoutFeed } from "../shouts/ShoutFeed.tsx";
import { HOME_COPY as C } from "./copy.ts";
import styles from "./HomePage.module.css";

const route = getRouteApi("/");
const CHANGES_SHOWN = 5;
const LISTINGS_SHOWN = 4;
const AVATARS_SHOWN = 5;

function Strip({
    total,
    newest,
}: {
    readonly total: number | null;
    readonly newest: string | null;
}) {
    const presence = usePresence();
    return (
        <footer className={styles.strip}>
            <span className={styles.here}>
                {presence === null ? null : (
                    <>
                        <span className={styles.faces}>
                            {presence.roster.slice(0, AVATARS_SHOWN).map((entry) => (
                                <Avatar key={entry.username} digest={entry.avatar} size="small" />
                            ))}
                        </span>
                        {C.here_n(presence.online)}
                    </>
                )}
            </span>
            <span className={styles.facts}>
                {total === null ? null : <Link to="/community">{C.membersN(total)}</Link>}
                {newest === null ? null : (
                    <Link to="/members/$username" params={{ username: newest }}>
                        {C.newestName(newest)}
                    </Link>
                )}
            </span>
        </footer>
    );
}

// Home: the shout feed on the left under its own head row, what is going on in the member's
// products on the right (each block only when it has something), and a strip at the foot of the
// window with who is here and the newest member.
export function HomePage() {
    const data = route.useLoaderData();
    const { session } = useRouteContext({ from: "__root__" });
    if (data === null) return null;
    const viewer = memberOf(session);
    const canPurge = viewer !== null && can(subjectOf(viewer), "moderation:remove");
    const held = data.products.ok
        ? data.products.value.filter((p) => p.access !== null && p.productId !== LOADER_PRODUCT_ID)
        : [];
    const names = new Map(
        data.changes.ok ? data.changes.value.names.map((n) => [n.id, n.name]) : [],
    );
    const changes = data.changes.ok ? data.changes.value.entries.slice(0, CHANGES_SHOWN) : [];
    const listings = data.listings.ok ? data.listings.value.items.slice(0, LISTINGS_SHOWN) : [];
    const loaderReady = data.loader.ok && data.loader.value.state === "ready";
    return (
        <SiteShell>
            <div className={styles.frame}>
                <Page title={null} hideTitle>
                    <Columns
                        head={{ lead: <h1 className={styles.title}>{C.shouts}</h1> }}
                        main={
                            <div className={styles.feedBox}>
                                <ShoutFeed
                                    first={data.shouts}
                                    productId={null}
                                    canPurge={canPurge}
                                />
                            </div>
                        }
                        aside={
                            <>
                                {held.length === 0 && !loaderReady ? null : (
                                    <Section caption={C.products}>
                                        <ul className={styles.rows}>
                                            {held.map((product) => {
                                                const word = statusWord(product.state, null);
                                                return (
                                                    <li key={product.productId}>
                                                        <Link
                                                            to="/products/$productId"
                                                            params={{
                                                                productId: product.productId,
                                                            }}
                                                            className={styles.row}
                                                        >
                                                            <span>{productName(product.name)}</span>
                                                            {word === null ? null : (
                                                                <span
                                                                    className={styles.end}
                                                                    data-tone={word.tone}
                                                                >
                                                                    {word.word}
                                                                </span>
                                                            )}
                                                        </Link>
                                                    </li>
                                                );
                                            })}
                                            {loaderReady ? (
                                                <li>
                                                    <form
                                                        method="get"
                                                        action="/download/lucent-loader.exe"
                                                        className={styles.row}
                                                    >
                                                        <span>{C.loader}</span>
                                                        <button
                                                            type="submit"
                                                            className={styles.download}
                                                        >
                                                            {C.download}
                                                        </button>
                                                    </form>
                                                </li>
                                            ) : null}
                                        </ul>
                                    </Section>
                                )}
                                {changes.length === 0 ? null : (
                                    <Section
                                        caption={C.changes}
                                        actions={<Link to="/changes">{C.all}</Link>}
                                    >
                                        <ul className={styles.rows}>
                                            {changes.map((entry) => {
                                                const subject =
                                                    entry.subject === "loader"
                                                        ? C.loader
                                                        : entry.subject === "service" ||
                                                            entry.productId === null
                                                          ? C.lucent
                                                          : productName(
                                                                names.get(entry.productId) ??
                                                                    entry.productId,
                                                            );
                                                return (
                                                    <li key={entry.id}>
                                                        <Link
                                                            to="/changes"
                                                            hash={entry.id}
                                                            className={styles.row}
                                                        >
                                                            <span className={styles.line}>
                                                                {subject}{" "}
                                                                {entry.version ?? entry.title}
                                                            </span>
                                                            <span className={styles.end}>
                                                                <Time
                                                                    at={entry.publishedAt}
                                                                    format="day"
                                                                />
                                                            </span>
                                                        </Link>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </Section>
                                )}
                                {listings.length === 0 ? null : (
                                    <Section
                                        caption={C.newInCloud}
                                        actions={<Link to="/cloud">{C.all}</Link>}
                                    >
                                        <ul className={styles.rows}>
                                            {listings.map((listing) => (
                                                <ListingRow
                                                    key={listing.id}
                                                    listing={listing}
                                                    variant="brief"
                                                />
                                            ))}
                                        </ul>
                                    </Section>
                                )}
                            </>
                        }
                    />
                </Page>
                <Strip
                    total={data.members.ok ? data.members.value.total : null}
                    newest={data.newest.ok ? (data.newest.value.items[0]?.username ?? null) : null}
                />
            </div>
        </SiteShell>
    );
}
