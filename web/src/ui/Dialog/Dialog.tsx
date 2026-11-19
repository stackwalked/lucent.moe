import { type ReactNode, useEffect, useId, useRef } from "react";
import { UI_COPY } from "../copy.ts";
import { IconButton } from "../IconButton/IconButton.tsx";
import styles from "./Dialog.module.css";

// A modal `<dialog>`: the browser traps focus, makes the page behind inert, and closes on Esc.
// `open` is the caller's state; Esc and the close button both end in `onClose`, where the caller
// sets it false. The content stays mounted while closed so it can animate out. While usy,
// a request is out that the dialog shows the answer to: Esc and the close button stay out of it.
export function Dialog({
    open,
    onClose,
    title,
    busy = false,
    actions,
    children,
}: {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly title: string;
    readonly busy?: boolean;
    // The footer: the buttons that answer the dialog.
    readonly actions?: ReactNode;
    readonly children: ReactNode;
}) {
    const titleId = useId();
    const dialog = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const element = dialog.current;
        if (element === null) return;
        if (open && !element.open) element.showModal();
        if (!open && element.open) element.close();
    }, [open]);

    return (
        <dialog
            ref={dialog}
            className={styles.dialog}
            aria-labelledby={titleId}
            aria-busy={busy}
            onCancel={(event) => {
                if (busy) event.preventDefault();
            }}
            // Closing because `open` went false fires this too, after the caller already knows.
            onClose={() => {
                if (open) onClose();
            }}
        >
            <div className={styles.panel}>
                <header className={styles.head}>
                    <h2 id={titleId} className={styles.title}>
                        {title}
                    </h2>
                    {busy ? null : <IconButton icon="x" label={UI_COPY.close} onClick={onClose} />}
                </header>
                <div className={styles.body}>{children}</div>
                {actions === undefined ? null : (
                    <footer className={styles.actions}>{actions}</footer>
                )}
            </div>
        </dialog>
    );
}
