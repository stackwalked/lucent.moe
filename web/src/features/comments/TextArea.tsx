import { type ReactNode, useId } from "react";
import fieldStyles from "../../ui/Field/Field.module.css";
import { useFieldValidity } from "../../ui/Field/useFieldValidity.ts";
import styles from "./TextArea.module.css";

// What members write: a labelled multi-line field. The server trims and bounds it again.
// By default it is three lines you can drag taller. "line" is a comment input: one line growing
// with its text to four, no visible label (the placeholder says it), and `end` (its "post") at
// the end of the same row; Enter sends, Shift+Enter breaks the line. "grow" is a reply box: three
// lines growing to eight.
export function TextArea({
    name,
    label,
    maxLength,
    required = false,
    defaultValue,
    size,
    end,
}: {
    readonly name: string;
    readonly label: string;
    readonly maxLength: number;
    readonly required?: boolean;
    readonly defaultValue?: string;
    readonly size?: "line" | "grow";
    readonly end?: ReactNode;
}) {
    const id = useId();
    const errorId = `${id}-error`;
    // The same check a TextField gets: required means something other than spaces.
    const { ref, message } = useFieldValidity();
    const inline = size === "line";
    return (
        <div className={styles.field}>
            {inline ? null : (
                <label htmlFor={id} className={styles.label}>
                    {label}
                </label>
            )}
            <div className={styles.row}>
                <textarea
                    id={id}
                    className={styles.area}
                    data-size={size}
                    name={name}
                    maxLength={maxLength}
                    required={required}
                    rows={1}
                    ref={(area) => (area === null ? undefined : ref(area))}
                    aria-invalid={message !== undefined}
                    {...(inline ? { "aria-label": label, placeholder: label } : {})}
                    {...(message === undefined ? {} : { "aria-describedby": errorId })}
                    {...(defaultValue === undefined ? {} : { defaultValue })}
                    {...(inline
                        ? {
                              onKeyDown: (event) => {
                                  if (
                                      event.key === "Enter" &&
                                      !event.shiftKey &&
                                      !event.nativeEvent.isComposing
                                  ) {
                                      event.preventDefault();
                                      event.currentTarget.form?.requestSubmit();
                                  }
                              },
                          }
                        : {})}
                />
                {end}
            </div>
            {message === undefined ? null : (
                <p id={errorId} className={fieldStyles.error}>
                    {message}
                </p>
            )}
        </div>
    );
}
