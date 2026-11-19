import { Button } from "../Button/Button.tsx";
import { UI_COPY } from "../copy.ts";
import styles from "./Pager.module.css";

// Forward only, by cursor: no totals, no page numbers. At the last page there is nothing to show.
export function Pager({
    nextCursor,
    onNext,
}: {
    readonly nextCursor: string | null;
    readonly onNext: (cursor: string) => void;
}) {
    if (nextCursor === null) return null;
    return (
        <div className={styles.pager}>
            <Button size="sm" onClick={() => onNext(nextCursor)}>
                {UI_COPY.nextPage}
            </Button>
        </div>
    );
}
