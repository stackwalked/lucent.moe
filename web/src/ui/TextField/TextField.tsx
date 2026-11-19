import { Field } from "../Field/Field.tsx";

type TextFieldProps = {
    readonly name: string;
    readonly label: string;
    // "password" is for a password being typed in (sign-in); a new one is NewPassword.
    readonly type?: "text" | "email" | "search" | "password";
    readonly hint?: string;
    readonly error?: string;
    readonly required?: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    // A rule the attributes can't state; returns the message while the value breaks it.
    readonly customCheck?: (value: string) => string | undefined;
    readonly autoComplete?: string;
    readonly inputMode?: "text" | "email" | "search" | "numeric";
    readonly defaultValue?: string;
};

export function TextField({
    name,
    label,
    type = "text",
    hint,
    error,
    required = false,
    minLength,
    maxLength,
    pattern,
    customCheck,
    autoComplete,
    inputMode,
    defaultValue,
}: TextFieldProps) {
    return (
        <Field
            label={label}
            {...(hint === undefined ? {} : { hint })}
            {...(error === undefined ? {} : { error })}
            {...(customCheck === undefined ? {} : { customCheck })}
        >
            {(control) => (
                <input
                    {...control}
                    name={name}
                    type={type}
                    required={required}
                    {...(minLength === undefined ? {} : { minLength })}
                    {...(maxLength === undefined ? {} : { maxLength })}
                    {...(pattern === undefined ? {} : { pattern })}
                    {...(autoComplete === undefined ? {} : { autoComplete })}
                    {...(inputMode === undefined ? {} : { inputMode })}
                    {...(defaultValue === undefined ? {} : { defaultValue })}
                />
            )}
        </Field>
    );
}
