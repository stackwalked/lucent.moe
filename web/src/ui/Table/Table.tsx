import type { ReactNode } from "react";
import { UI_COPY } from "../copy.ts";
import styles from "./Table.module.css";

export type Column<Row> = {
    readonly key: string;
    readonly header: string;
    readonly cell: (row: Row) => ReactNode;
    readonly align?: "end";
};

// A dense table. The header stays in view while the rows scroll, and a table wider than its
// space scrolls sideways inside itself, never the page.
//
// `rowLink` makes the whole row a link to its detail page: it gets the row and the first cell's
// content and returns that content inside the router's `Link`. The link stretches over the row,
// so the row has one tab stop and one name.
export function Table<Row>({
    caption,
    columns,
    rows,
    rowKey,
    rowLink,
}: {
    // What the table is, for screen readers.
    readonly caption: string;
    readonly columns: readonly Column<Row>[];
    readonly rows: readonly Row[];
    readonly rowKey: (row: Row) => string;
    readonly rowLink?: (row: Row, content: ReactNode) => ReactNode;
}) {
    return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
        <section className={styles.scroller} aria-label={caption} tabIndex={0}>
            <table className={styles.table}>
                <caption className={styles.caption}>{caption}</caption>
                <thead>
                    <tr>
                        {columns.map((column) => (
                            <th
                                key={column.key}
                                scope="col"
                                className={styles.head}
                                {...(column.align === undefined
                                    ? {}
                                    : { "data-align": column.align })}
                            >
                                {column.header === "" ? (
                                    <span className={styles.hidden}>{UI_COPY.actions}</span>
                                ) : (
                                    column.header
                                )}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr
                            key={rowKey(row)}
                            className={styles.row}
                            {...(rowLink === undefined ? {} : { "data-linked": "" })}
                        >
                            {columns.map((column, index) => (
                                <td
                                    key={column.key}
                                    className={styles.cell}
                                    {...(column.align === undefined
                                        ? {}
                                        : { "data-align": column.align })}
                                >
                                    {index === 0 && rowLink !== undefined
                                        ? rowLink(row, column.cell(row))
                                        : column.cell(row)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
}
