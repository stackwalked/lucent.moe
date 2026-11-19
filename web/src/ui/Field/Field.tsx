import { type ReactNode, useId } from "react";
import styles from "./Field.module.css";
import { useFieldValidity } from "./useFieldValidity.ts";

// What a field hands to the input it wraps: spread it onto one native `<input>`.
export type FieldControl = {
    readonly id: string;
    readonly className: string;
    readonly ref: (input: HTMLInputElement) => () => void;
    readonly "aria-invalid": boolean;
    readonly "aria-describedby"?: string;
};

// A label, an optional hint and the error under one input. `error` is a message from the
// server; the browser's own constraint messages (useFieldValidity) take precedence while the
// input is invalid.
export function Field({
    label,
    hint,
    error,
    customCheck,
    children,
}: {
    readonly label: string;
    readonly hint?: ReactNode;
    readonly error?: string;
    readonly customCheck?: (value: string) => string | undefined;
    readonly children: (control: FieldControl) => ReactNode;
}) {
    const id = useId();
    const hintId = `${id}-hint`;
    const errorId = `${id}-error`;
    const { ref, message } = useFieldValidity(customCheck);
    const shown = message ?? error;
    const describedBy = [
        ...(hint === undefined ? [] : [hintId]),
        ...(shown === undefined ? [] : [errorId]),
    ].join(" ");
    return (
        <div className={styles.field}>
            <label htmlFor={id} className={styles.label}>
                {label}
            </label>
            {children({
                id,
                className: styles.input ?? "",
                ref,
                "aria-invalid": shown !== undefined,
                ...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
            })}
            {hint === undefined ? null : (
                <p id={hintId} className={styles.hint}>
                    {hint}
                </p>
            )}
            {shown === undefined ? null : (
                <p id={errorId} className={styles.error}>
                    {shown}
                </p>
            )}
        </div>
    );
}
