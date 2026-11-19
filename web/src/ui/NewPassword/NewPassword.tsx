import { useState } from "react";
import { UI_COPY } from "../copy.ts";
import { Field } from "../Field/Field.tsx";
import { IconButton } from "../IconButton/IconButton.tsx";
import { passwordHint, passwordLength, passwordProblem } from "./length.ts";
import styles from "./NewPassword.module.css";

// Choosing a password: shown or hidden on request, with a live count against the limits.
export function NewPassword({
    name,
    label,
    error,
}: {
    readonly name: string;
    readonly label: string;
    readonly error?: string;
}) {
    const [shown, setShown] = useState(false);
    const [count, setCount] = useState(0);
    return (
        <Field
            label={label}
            hint={passwordHint(count)}
            customCheck={passwordProblem}
            {...(error === undefined ? {} : { error })}
        >
            {(control) => (
                <div className={styles.row}>
                    <input
                        {...control}
                        name={name}
                        type={shown ? "text" : "password"}
                        autoComplete="new-password"
                        required
                        onInput={(event) => setCount(passwordLength(event.currentTarget.value))}
                    />
                    <IconButton
                        icon={shown ? "eye-off" : "eye"}
                        label={shown ? UI_COPY.hidePassword : UI_COPY.showPassword}
                        onClick={() => setShown(!shown)}
                    />
                </div>
            )}
        </Field>
    );
}
