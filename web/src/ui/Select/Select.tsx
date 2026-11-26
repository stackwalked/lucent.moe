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
    value,
    onChange,
    required = false,
}: {
    readonly name: string;
    readonly label: string;
    readonly options: readonly SelectOption[];
    readonly defaultValue?: string;
    // Controlled, for a form whose other fields follow the choice.
    readonly value?: string;
    readonly onChange?: (value: string) => void;
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
                {...(value === undefined ? {} : { value })}
                {...(onChange === undefined
                    ? {}
                    : { onChange: (event) => onChange(event.currentTarget.value) })}
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
