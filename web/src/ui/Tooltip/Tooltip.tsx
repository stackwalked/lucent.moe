import { type ReactNode, useId, useRef } from "react";
import styles from "./Tooltip.module.css";

// A word or two about a control, shown while the pointer is on it or it has focus. A hint
// popover: it never closes an open menu, and Esc dismisses it. It adds to the trigger's own
// accessible name, never replaces it. Anchored like Popover (see there).
export function Tooltip({
    text,
    children,
}: {
    readonly text: string;
    readonly children: ReactNode;
}) {
    const id = useId();
    const tip = useRef<HTMLSpanElement>(null);

    function show() {
        const element = tip.current;
        if (element?.matches(":popover-open") === false) element.showPopover();
    }

    function hide() {
        const element = tip.current;
        if (element?.matches(":popover-open")) element.hidePopover();
    }

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: it only listens to what its focusable child receives
        <span
            className={styles.host}
            aria-describedby={id}
            onPointerEnter={show}
            onPointerLeave={hide}
            onFocus={show}
            onBlur={hide}
        >
            <span className={styles.target}>{children}</span>
            <span ref={tip} id={id} role="tooltip" popover="hint" className={styles.tip}>
                {text}
            </span>
        </span>
    );
}
