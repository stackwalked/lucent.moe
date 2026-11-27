import { Link } from "@tanstack/react-router";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { CLOUD_COPY as C } from "./copy.ts";
import styles from "./ListingRow.module.css";
import type { fetchListings } from "./server.ts";

type Listed = Extract<Awaited<ReturnType<typeof fetchListings>>, { readonly ok: true }>["value"];
export type Listing = Listed["items"][number];

// One listing. The name opens its page, which is the only place to add it; "added" in ok-ink says
// you hold a copy. "full" is the cloud page's row: name and kind, the summary, the owner, the
// date. "brief" is the small blocks' row: name, then kind and the owner (or the product, `after`).
// Shared by the cloud page, a product's "new in cloud" and a profile's "shared".
export function ListingRow({
    listing,
    variant,
    after,
}: {
    readonly listing: Listing;
    readonly variant: "full" | "brief";
    readonly after?: string;
}) {
    const { owner } = listing;
    const who =
        owner.username === null ? (
            C.copyOf(null)
        ) : (
            <Link to="/members/$username" params={{ username: owner.username }}>
                {owner.username}
            </Link>
        );
    const name = (
        <Link
            to="/products/$productId/cloud/$listingId"
            params={{ productId: listing.productId, listingId: listing.id }}
            className={styles.name}
        >
            {listing.name}
        </Link>
    );
    const added = <span className={styles.added}>{listing.added ? C.added : null}</span>;
    if (variant === "brief") {
        return (
            <li className={styles.brief}>
                <span className={styles.text}>
                    {name}
                    <span className={styles.small}>
                        {listing.kind} · {after ?? who}
                    </span>
                </span>
                {added}
            </li>
        );
    }
    return (
        <li className={styles.full}>
            <span className={styles.text}>
                <span>
                    {name} <span className={styles.small}>{listing.kind}</span>
                </span>
                {listing.summary === "" ? null : (
                    <span className={styles.summary}>{listing.summary}</span>
                )}
            </span>
            <span className={styles.owner}>
                <span className={styles.pic}>
                    <Avatar digest={owner.avatar} size="small" />
                </span>
                {who}
            </span>
            <span className={styles.when}>
                <Time at={listing.updatedAt} format="date" />
            </span>
            {added}
        </li>
    );
}
