import styles from "./Check.module.css";

export function Check({
    name,
    label,
    value,
    defaultChecked = false,
    disabled = false,
}: {
    readonly name: string;
    readonly label: string;
    readonly value?: string;
    readonly defaultChecked?: boolean;
    readonly disabled?: boolean;
}) {
    return (
        <label className={styles.check}>
            <input
                className={styles.box}
                type="checkbox"
                name={name}
                defaultChecked={defaultChecked}
                disabled={disabled}
                {...(value === undefined ? {} : { value })}
            />
            <span>{label}</span>
        </label>
    );
}
