import { useId } from "react";
import styles from "./Select.module.css";

export type SelectOption = { readonly value: string; readonly label: string };

// A labelled native select. The label points at the select by id rather than wrapping it: a
// wrapping label's name takes in the chosen option's text too.
export function Select({
    name,
    label,
    options,
    defaultValue,
    required = false,
}: {
    readonly name: string;
    readonly label: string;
    readonly options: readonly SelectOption[];
    readonly defaultValue?: string;
    readonly required?: boolean;
}) {
    const id = useId();
    return (
        <div className={styles.field}>
            <label htmlFor={id} className={styles.label}>
                {label}
            </label>
            <select
                id={id}
                name={name}
                required={required}
                className={styles.control}
                {...(defaultValue === undefined ? {} : { defaultValue })}
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    );
}
