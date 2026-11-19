import styles from "./QrCode.module.css";

// Rows of "1" (dark) and "0" from the server, as one SVG path. Always dark on light (a Washi
// subtree), whatever the page's theme: scanners read inverted codes badly.
export function QrCode({
    rows,
    label,
}: {
    readonly rows: readonly string[];
    readonly label: string;
}) {
    const size = rows.length;
    const path = rows
        .flatMap((row, y) => [...row].map((cell, x) => (cell === "1" ? `M${x} ${y}h1v1h-1z` : "")))
        .join("");
    return (
        <div className={styles.frame} data-theme="washi">
            <svg
                className={styles.code}
                viewBox={`0 0 ${size} ${size}`}
                role="img"
                aria-label={label}
            >
                <path d={path} />
            </svg>
        </div>
    );
}
