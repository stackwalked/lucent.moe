import { useCallback, useState } from "react";
import { UI_COPY } from "../copy.ts";

// One submit event is checked once for the whole form, however many fields listen to it.
const submits = new WeakMap<HTMLFormElement, { readonly event: Event; focusPending: boolean }>();

type Control = HTMLInputElement | HTMLTextAreaElement;

// The browser's `required` is satisfied by spaces alone, and the server trims before it checks:
// a field of only spaces would pass here, be refused there, and take the page down with it.
function blank(input: Control): boolean {
    return input.required && input.value !== "" && input.value.trim() === "";
}

function firstFailure(input: Control): string | undefined {
    const v = input.validity;
    if (v.valid) return undefined;
    if (v.valueMissing) return UI_COPY.required;
    if (v.tooShort) return UI_COPY.tooShort(input.minLength);
    if (v.tooLong) return UI_COPY.tooLong(input.maxLength);
    if (v.customError) return input.validationMessage;
    return UI_COPY.badFormat;
}

// Forms are uncontrolled and `noValidate`: the browser's constraint attributes (required,
// minLength, maxLength, pattern, type) decide, and this reads them. The message shows after
// the field is left or its form is submitted, and from then on follows what is typed.
// `customCheck` is for rules the attributes can't state (the password's length counts code
// points); it's held as the input's custom validity so the form's own check sees it too.
// A submit with an invalid field is stopped, and focus goes to the first invalid one.
export function useFieldValidity(customCheck?: (value: string) => string | undefined) {
    const [message, setMessage] = useState<string | undefined>(undefined);
    const ref = useCallback(
        (input: Control) => {
            const sync = () =>
                input.setCustomValidity(
                    blank(input) ? UI_COPY.required : (customCheck?.(input.value) ?? ""),
                );
            const show = () => {
                sync();
                setMessage(firstFailure(input));
            };
            const onInput = () => {
                sync();
                setMessage((shown) => (shown === undefined ? undefined : firstFailure(input)));
            };
            const onInvalid = () => {
                setMessage(firstFailure(input));
                const form = input.form;
                const turn = form === null ? undefined : submits.get(form);
                if (turn?.focusPending) {
                    turn.focusPending = false;
                    input.focus();
                }
            };
            const form = input.form;
            const onSubmit = (event: Event) => {
                if (form === null || submits.get(form)?.event === event) return;
                const turn = { event, focusPending: true };
                submits.set(form, turn);
                const valid = form.checkValidity();
                turn.focusPending = false;
                if (!valid) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
            };
            sync();
            input.addEventListener("blur", show);
            input.addEventListener("input", onInput);
            input.addEventListener("invalid", onInvalid);
            form?.addEventListener("submit", onSubmit, { capture: true });
            return () => {
                input.removeEventListener("blur", show);
                input.removeEventListener("input", onInput);
                input.removeEventListener("invalid", onInvalid);
                form?.removeEventListener("submit", onSubmit, { capture: true });
            };
        },
        [customCheck],
    );
    return { ref, message };
}
