import { type ReactNode, useId } from "react";
import styles from "./Popover.module.css";

// A panel that opens from its trigger and closes on Esc, a click outside, or another popover:
// all native (`popover="auto"`), as is putting focus back on the trigger. The trigger is the
// caller's, given the id to point `popoverTarget` at.
//
// Anchoring without a style prop: the wrapper's `anchor-scope` makes the anchor name resolve
// per instance, so one name in CSS serves every popover on the page.
export function Popover({
    trigger,
    align = "start",
    flush = false,
    onOpen,
    children,
}: {
    readonly trigger: (popoverTarget: string) => ReactNode;
    // Which edge of the trigger the panel lines up with.
    readonly align?: "start" | "end";
    // No padding of its own, for content that pads itself (a menu).
    readonly flush?: boolean;
    readonly onOpen?: () => void;
    readonly children: ReactNode;
}) {
    const id = useId();
    return (
        <span className={styles.root}>
            <span className={styles.anchor}>{trigger(id)}</span>
            <div
                id={id}
                popover="auto"
                className={styles.panel}
                data-align={align}
                data-flush={flush}
                onToggle={(event) => {
                    if (event.newState === "open") onOpen?.();
                }}
            >
                {children}
            </div>
        </span>
    );
}
