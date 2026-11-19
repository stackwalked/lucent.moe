import { useState } from "react";
import styles from "./Switch.module.css";

// A setting that is either on or off. A native checkbox, announced as a switch.
export function Switch({
    name,
    label,
    defaultChecked = false,
    disabled = false,
    onChange,
}: {
    readonly name: string;
    readonly label: string;
    readonly defaultChecked?: boolean;
    readonly disabled?: boolean;
    readonly onChange?: (checked: boolean) => void;
}) {
    const [checked, setChecked] = useState(defaultChecked);
    return (
        <label className={styles.switch}>
            <input
                className={styles.track}
                type="checkbox"
                role="switch"
                name={name}
                checked={checked}
                aria-checked={checked}
                disabled={disabled}
                onChange={(event) => {
                    setChecked(event.currentTarget.checked);
                    onChange?.(event.currentTarget.checked);
                }}
            />
            <span>{label}</span>
        </label>
    );
}
