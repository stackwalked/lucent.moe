import { useId } from "react";
import fieldStyles from "../../ui/Field/Field.module.css";
import { useFieldValidity } from "../../ui/Field/useFieldValidity.ts";
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
    const errorId = `${id}-error`;
    // The same check a TextField gets: required means something other than spaces.
    const { ref, message } = useFieldValidity();
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
                ref={(area) => (area === null ? undefined : ref(area))}
                aria-invalid={message !== undefined}
                {...(message === undefined ? {} : { "aria-describedby": errorId })}
                {...(defaultValue === undefined ? {} : { defaultValue })}
            />
            {message === undefined ? null : (
                <p id={errorId} className={fieldStyles.error}>
                    {message}
                </p>
            )}
        </div>
    );
}
