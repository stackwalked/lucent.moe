import type { ClipboardEvent, InputEvent } from "react";
import { Field } from "../Field/Field.tsx";
import styles from "./CodeInput.module.css";
import { CODE_LENGTH, codeDigits } from "./digits.ts";

// A one-time code: digits only, and the form submits itself when the sixth arrives. The value
// stays in the DOM (the form reads it); there is nothing to keep in React.
function settle(input: HTMLInputElement) {
    const digits = codeDigits(input.value);
    if (digits !== input.value) input.value = digits;
    if (digits.length === CODE_LENGTH) input.form?.requestSubmit();
}

export function CodeInput({
    name,
    label,
    hint,
    error,
}: {
    readonly name: string;
    readonly label: string;
    readonly hint?: string;
    readonly error?: string;
}) {
    return (
        <Field
            label={label}
            {...(hint === undefined ? {} : { hint })}
            {...(error === undefined ? {} : { error })}
        >
            {(control) => (
                <input
                    {...control}
                    className={`${control.className} ${styles.code}`}
                    name={name}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={CODE_LENGTH}
                    required
                    onInput={(event: InputEvent<HTMLInputElement>) => settle(event.currentTarget)}
                    // maxLength would cut "123 456" at six characters before the spaces go.
                    onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
                        event.preventDefault();
                        const input = event.currentTarget;
                        input.value = codeDigits(event.clipboardData.getData("text"));
                        input.dispatchEvent(new Event("input", { bubbles: true }));
                        settle(input);
                    }}
                />
            )}
        </Field>
    );
}
