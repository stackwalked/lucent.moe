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
    return (
        <label className={styles.field}>
            <span className={styles.label}>{label}</span>
            <textarea
                className={styles.area}
                name={name}
                maxLength={maxLength}
                required={required}
                {...(defaultValue === undefined ? {} : { defaultValue })}
            />
        </label>
    );
}
