import { Fragment, type KeyboardEvent, type ReactNode, useRef } from "react";
import { Icon } from "../Icon/Icon.tsx";
import { Popover } from "../Popover/Popover.tsx";
import styles from "./ProductPick.module.css";

export type ProductPickRow = {
    readonly id: string;
    readonly label: string;
    // What the row's end says: the product's status word in its hue, "no-access" for one the
    // viewer doesn't hold, or nothing.
    readonly status:
        | { readonly word: string; readonly tone: "ok" | "wait" | "shu" | "dim" }
        | "no-access"
        | null;
};

const ITEM = "a";

// The product page's title is also how you switch products: the name with its chevron opens the
// listed products, each with its status at the row's end, the current one marked. The rows are
// the caller's links (linkFor) — plain anchors in the panel, the arrow keys moving focus between
// them and Enter the link's own activation — so the changes, cloud and docs pages can each keep
// their own destination and add rows that are not products at all.
export function ProductPick({
    label,
    rows,
    current,
    linkFor,
}: {
    readonly label: string;
    readonly rows: readonly ProductPickRow[];
    readonly current: string;
    readonly linkFor: (id: string, children: ReactNode) => ReactNode;
}) {
    const menu = useRef<HTMLDivElement>(null);

    function entries(): readonly HTMLElement[] {
        return menu.current === null ? [] : [...menu.current.querySelectorAll<HTMLElement>(ITEM)];
    }

    function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const all = entries();
        const at = event.target instanceof HTMLElement ? all.indexOf(event.target) : -1;
        const move = (index: number) => {
            event.preventDefault();
            all[(index + all.length) % all.length]?.focus();
        };
        switch (event.key) {
            case "ArrowDown":
                return move(at + 1);
            case "ArrowUp":
                return move(at < 0 ? -1 : at - 1);
            case "Home":
                return move(0);
            case "End":
                return move(-1);
            case "Tab":
                return event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
        }
    }

    return (
        <Popover
            flush
            trigger={(popoverTarget) => (
                <button type="button" className={styles.pick} popoverTarget={popoverTarget}>
                    <span className={styles.name}>{label}</span>
                    <Icon name="chevron-down" size={16} />
                </button>
            )}
            onOpen={() => entries()[0]?.focus()}
        >
            <div
                ref={menu}
                role="menu"
                aria-label={label}
                className={styles.menu}
                onKeyDown={onKeyDown}
                onClick={(event) =>
                    event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover()
                }
            >
                {rows.map((row) => (
                    <Fragment key={row.id}>
                        {linkFor(
                            row.id,
                            <span
                                className={styles.row}
                                aria-current={row.id === current ? "true" : undefined}
                            >
                                <span>{row.label}</span>
                                {row.status === null ? null : row.status === "no-access" ? (
                                    <span className={styles.noAccess}>no access</span>
                                ) : (
                                    <span className={styles.word} data-tone={row.status.tone}>
                                        {row.status.word}
                                    </span>
                                )}
                            </span>,
                        )}
                    </Fragment>
                ))}
            </div>
        </Popover>
    );
}
