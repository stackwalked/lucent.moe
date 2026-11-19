import sprite from "../icons/sprite.gen.svg?url";
import styles from "./Icon.module.css";
import type { IconName } from "./names.ts";

export type { IconName };

// Drawn in the text color around it. Decorative unless given a label, which a control without
// visible text needs.
export function Icon({
    name,
    size = 16,
    label,
}: {
    readonly name: IconName;
    readonly size?: 16 | 20 | 24;
    readonly label?: string;
}) {
    const shape = {
        className: styles.icon,
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
    } as const;
    const use = <use href={`${sprite}#${name}`} />;
    if (label === undefined) {
        return (
            <svg {...shape} aria-hidden="true">
                {use}
            </svg>
        );
    }
    return (
        <svg {...shape} role="img" aria-label={label}>
            {use}
        </svg>
    );
}
