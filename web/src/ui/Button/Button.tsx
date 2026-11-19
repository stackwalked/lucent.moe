import type { ReactNode } from "react";
import { UI_COPY } from "../copy.ts";
import { Icon, type IconName } from "../Icon/Icon.tsx";
import styles from "./Button.module.css";

// pink: the one thing to do here (create, continue); plain: any other action; ghost: quiet
// actions in dense places; danger: stops or removes something.
export type ButtonTone = "pink" | "plain" | "ghost" | "danger";

export function Button({
    tone = "plain",
    size = "md",
    type = "button",
    icon,
    pending = false,
    disabled = false,
    pressed,
    label,
    onClick,
    popoverTarget,
    form,
    name,
    value,
    children,
}: {
    readonly tone?: ButtonTone;
    readonly size?: "md" | "sm";
    readonly type?: "button" | "submit";
    readonly icon?: IconName;
    // Working on it: the label stays, a spinner joins it, and the button takes no more presses.
    readonly pending?: boolean;
    readonly disabled?: boolean;
    // A toggle, or the chosen one of a set (a sort): said to screen readers as well as shown.
    readonly pressed?: boolean;
    // The name a screen reader says, when the visible text needs its context: "take away" in a row
    // of roles is "take away support".
    readonly label?: string;
    readonly onClick?: () => void;
    readonly popoverTarget?: string;
    readonly form?: string;
    readonly name?: string;
    readonly value?: string;
    readonly children: ReactNode;
}) {
    return (
        <button
            className={styles.button}
            data-tone={tone}
            data-size={size}
            type={type}
            disabled={disabled || pending}
            aria-busy={pending}
            {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
            {...(label === undefined ? {} : { "aria-label": label })}
            {...(onClick === undefined ? {} : { onClick })}
            {...(popoverTarget === undefined ? {} : { popoverTarget })}
            {...(form === undefined ? {} : { form })}
            {...(name === undefined ? {} : { name })}
            {...(value === undefined ? {} : { value })}
        >
            {pending ? (
                <span className={styles.spin}>
                    <Icon name="loader-circle" label={UI_COPY.loading} />
                </span>
            ) : icon === undefined ? null : (
                <Icon name={icon} />
            )}
            <span>{children}</span>
        </button>
    );
}
