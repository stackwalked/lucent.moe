import { Icon, type IconName } from "../Icon/Icon.tsx";
import styles from "./IconButton.module.css";

// A square control with only an icon: the label is what screen readers and the tooltip say.
export function IconButton({
    icon,
    label,
    size = "md",
    onClick,
    popoverTarget,
}: {
    readonly icon: IconName;
    readonly label: string;
    readonly size?: "md" | "sm";
    readonly onClick?: () => void;
    readonly popoverTarget?: string;
}) {
    return (
        <button
            className={styles.button}
            data-size={size}
            type="button"
            aria-label={label}
            title={label}
            {...(onClick === undefined ? {} : { onClick })}
            {...(popoverTarget === undefined ? {} : { popoverTarget })}
        >
            <Icon name={icon} />
        </button>
    );
}
