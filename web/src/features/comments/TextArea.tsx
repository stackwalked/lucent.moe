import { useId } from "react";
import styles from "./TextArea.module.css";

// What members write: a labelled multi-line field. The server trims and bounds it again.
export function TextArea({
    name,
    label,
    maxLength,
    required = false,
    defaultValue,
}: {
    readonly name: string;
    readonly label: string;
    readonly maxLength: number;
    readonly required?: boolean;
    readonly defaultValue?: string;
}) {
    const id = useId();
    return (
        <div className={styles.field}>
            <label htmlFor={id} className={styles.label}>
                {label}
            </label>
            <textarea
                id={id}
                className={styles.area}
                name={name}
                maxLength={maxLength}
                required={required}
                {...(defaultValue === undefined ? {} : { defaultValue })}
            />
        </div>
    );
}
