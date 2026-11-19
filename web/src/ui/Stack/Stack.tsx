import type { ReactNode } from "react";
import styles from "./Stack.module.css";

type Gap = 1 | 2 | 3 | 4 | 5 | 6;

// Children in a column (or, with `row`, a wrapping row), spaced by one step of the space scale.
export function Stack({
    gap = 3,
    direction = "column",
    align,
    children,
}: {
    readonly gap?: Gap;
    readonly direction?: "column" | "row";
    readonly align?: "start" | "center" | "end" | "baseline";
    readonly children: ReactNode;
}) {
    return (
        <div
            className={styles.stack}
            data-gap={gap}
            data-direction={direction}
            {...(align === undefined ? {} : { "data-align": align })}
        >
            {children}
        </div>
    );
}
