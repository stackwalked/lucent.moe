import { useRef, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Icon } from "../../ui/Icon/Icon.tsx";
import { Popover } from "../../ui/Popover/Popover.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { postingNote } from "../comments/posting.ts";
import { PROFILE_COPY as C } from "./copy.ts";
import styles from "./ImageControl.module.css";

type Answer = Outcome<null>;

// An image that is its own control in edit mode: it covers its parent (which positions it), dims
// under hover or focus and shows a pencil; activating it opens a popover on it with "upload" and,
// when there is an image, "remove", and the size and type line. A chosen file goes up at once;
// the popover closes when it took and stays with the refusal when it did not. The file input is
// hidden behind "upload", which opens it, so the picker is as reachable by keyboard as the button.
export function ImageControl({
    accept,
    has,
    verbs,
    upload,
    clear,
    answered,
    shape = "rect",
}: {
    readonly accept: string;
    readonly has: boolean;
    // The accessible names of the control and its two verbs for this image.
    readonly verbs: (verb: string) => string;
    readonly upload: (file: File) => Promise<Answer>;
    readonly clear: () => Promise<Answer>;
    readonly answered: () => Promise<void>;
    readonly shape?: "rect" | "round";
}) {
    const input = useRef<HTMLInputElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    const [pending, setPending] = useState(false);
    const settle = async (reply: Answer) => {
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) {
            menu.current?.closest<HTMLElement>("[popover]")?.hidePopover();
            await answered();
        }
        setPending(false);
    };
    const note = postingNote(refused);
    return (
        <div className={styles.control} data-shape={shape}>
            <Popover
                fill
                trigger={(target) => (
                    <button
                        type="button"
                        className={styles.edit}
                        aria-label={verbs(C.change)}
                        popoverTarget={target}
                    >
                        <Icon name="pencil" size={24} />
                    </button>
                )}
            >
                <div ref={menu} className={styles.menu}>
                    <RefusalNote
                        refused={refused}
                        {...(note === undefined ? {} : { extra: note })}
                    />
                    <input
                        ref={input}
                        type="file"
                        accept={accept}
                        hidden
                        tabIndex={-1}
                        aria-hidden="true"
                        onChange={async (event) => {
                            const file = event.currentTarget.files?.[0];
                            event.currentTarget.value = "";
                            if (file === undefined) return;
                            setPending(true);
                            await settle(await upload(file));
                        }}
                    />
                    <div className={styles.verbs}>
                        <Button
                            size="sm"
                            pending={pending}
                            label={verbs(C.upload)}
                            onClick={() => input.current?.click()}
                        >
                            {C.upload}
                        </Button>
                        {has ? (
                            <Button
                                size="sm"
                                disabled={pending}
                                label={verbs(C.remove)}
                                onClick={async () => {
                                    setPending(true);
                                    await settle(await clear());
                                }}
                            >
                                {C.remove}
                            </Button>
                        ) : null}
                    </div>
                    <p className={styles.hint}>{C.imageHint}</p>
                </div>
            </Popover>
        </div>
    );
}
