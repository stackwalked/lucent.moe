import { type ComponentPropsWithoutRef, type Ref, useState } from "react";
import { UI_COPY } from "../copy.ts";
import { Icon } from "../Icon/Icon.tsx";
import styles from "./Find.module.css";

type InputProps = Omit<
    ComponentPropsWithoutRef<"input">,
    "value" | "defaultValue" | "onChange" | "className" | "type" | "name" | "placeholder" | "ref"
>;

// A search with no box: an icon and a text input on the baseline of the tabs beside it, in a head
// row whose hairline is its underline. While it has focus or text a pink segment sits on the
// hairline under it, as under a current tab. Enter finds, and "clear" appears with the text and
// finds nothing. Uncontrolled from `value` (the caller keys it by what was found) unless `text`
// is given. In the staff bar (`place="bar"`) it fills the bar's height instead, so the segment
// lies on the bar's hairline.
export function Find({
    label,
    placeholder = label,
    value = null,
    text,
    onText,
    onFind,
    onClear,
    place = "head",
    maxLength = 64,
    inputRef,
    inputProps,
}: {
    // What screen readers call the input.
    readonly label: string;
    readonly placeholder?: string;
    readonly value?: string | null;
    readonly text?: string;
    readonly onText?: (text: string) => void;
    readonly onFind: (text: string) => void;
    readonly onClear?: () => void;
    readonly place?: "head" | "bar";
    readonly maxLength?: number;
    readonly inputRef?: Ref<HTMLInputElement>;
    readonly inputProps?: InputProps;
}) {
    const [own, setOwn] = useState(value ?? "");
    const current = text ?? own;
    const change = (next: string) => {
        setOwn(next);
        onText?.(next);
    };
    return (
        <search className={styles.find} data-place={place} data-filled={current !== ""}>
            <form
                className={styles.form}
                action={(form) => onFind(String(form.get("find") ?? "").trim())}
            >
                <Icon name="search" />
                <input
                    {...inputProps}
                    ref={inputRef}
                    className={styles.input}
                    type="search"
                    name="find"
                    aria-label={label}
                    placeholder={placeholder}
                    maxLength={maxLength}
                    autoComplete="off"
                    value={current}
                    onChange={(event) => change(event.currentTarget.value)}
                />
                {current === "" ? null : (
                    <button
                        type="button"
                        className={styles.clear}
                        onClick={() => {
                            change("");
                            (onClear ?? onFind)("");
                        }}
                    >
                        {UI_COPY.clear}
                    </button>
                )}
            </form>
        </search>
    );
}
