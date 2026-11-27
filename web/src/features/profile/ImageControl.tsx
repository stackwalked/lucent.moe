import { useRef, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { postingNote } from "../comments/posting.ts";
import { PROFILE_COPY as C } from "./copy.ts";
import styles from "./ProfilePage.module.css";

type Answer = Outcome<null>;

// The buttons that change one image where it is shown. A chosen file goes up at once; a refusal
// stays beside the buttons until the next try. The file input is hidden behind its button, which
// opens it, so the picker is as reachable by keyboard as the button is.
export function ImageControl({
    accept,
    has,
    add,
    verbs,
    upload,
    clear,
    answered,
}: {
    readonly accept: string;
    readonly has: boolean;
    // What the button says while there is no image ("change" when there is one).
    readonly add: string;
    // The accessible names of "change" and "remove" for this image.
    readonly verbs: (verb: string) => string;
    readonly upload: (file: File) => Promise<Answer>;
    readonly clear: () => Promise<Answer>;
    readonly answered: () => Promise<void>;
}) {
    const input = useRef<HTMLInputElement>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    const [pending, setPending] = useState(false);
    const settle = async (reply: Answer) => {
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await answered();
        setPending(false);
    };
    const note = postingNote(refused);
    return (
        <div className={styles.imageControl}>
            <RefusalNote refused={refused} {...(note === undefined ? {} : { extra: note })} />
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
            <Button
                size="sm"
                pending={pending}
                label={verbs(C.change)}
                onClick={() => input.current?.click()}
            >
                {has ? C.change : add}
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
    );
}
