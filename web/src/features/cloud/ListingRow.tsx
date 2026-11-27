import { Link, useRouteContext } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { memberOf } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { ReportButton } from "../comments/ReportButton.tsx";
import { CLOUD_COPY as C } from "./copy.ts";
import styles from "./ListingRow.module.css";
import type { fetchListings } from "./server.ts";
import { addListing } from "./server.ts";

type Listed = Extract<Awaited<ReturnType<typeof fetchListings>>, { readonly ok: true }>["value"];
export type Listing = Listed["items"][number];

// "add" for a listing not yet held, "added" in ok-ink once it is; a refusal is said under the
// row. Shared by the cloud page, a product's "new in cloud" and a profile's "shared".
function AddButton({ listing }: { readonly listing: Listing }) {
    const [added, setAdded] = useState(listing.added);
    const [pending, setPending] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    if (added) return <span className={styles.added}>{C.added}</span>;
    return (
        <span className={styles.add}>
            <Button
                size="sm"
                tone="ghost"
                pending={pending}
                onClick={async () => {
                    setPending(true);
                    const reply = await addListing({ data: { listingId: listing.id } });
                    setPending(false);
                    if (reply.ok) return setAdded(true);
                    if (reply.refused.code === "ALREADY_ADDED") return setAdded(true);
                    setRefused(reply.refused);
                }}
            >
                {C.add}
            </Button>
            {refused === null ? null : <RefusalNote refused={refused} />}
        </span>
    );
}

// One listing. "full" is the cloud page's row: name and kind, the summary, the owner, the date.
// "brief" is the small blocks' row: name, then kind and the owner (or the product, `after`).
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
    const { session } = useRouteContext({ from: "__root__" });
    // Your own listing is not yours to add or to report.
    const own = owner.username !== null && owner.username === memberOf(session)?.username;
    const action = own ? null : (
        <span className={styles.end}>
            <span className={styles.acts}>
                <ReportButton kind="listing" targetId={listing.id} />
            </span>
            <AddButton listing={listing} />
        </span>
    );
    const who =
        owner.username === null ? (
            C.copyOf(null)
        ) : (
            <Link to="/members/$username" params={{ username: owner.username }}>
                {owner.username}
            </Link>
        );
    if (variant === "brief") {
        return (
            <li className={styles.brief}>
                <span className={styles.text}>
                    <span className={styles.name}>{listing.name}</span>
                    <span className={styles.small}>
                        {listing.kind} · {after ?? who}
                    </span>
                </span>
                {action}
            </li>
        );
    }
    return (
        <li className={styles.full}>
            <span className={styles.text}>
                <span>
                    <span className={styles.name}>{listing.name}</span>{" "}
                    <span className={styles.small}>{listing.kind}</span>
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
            {action}
        </li>
    );
}
