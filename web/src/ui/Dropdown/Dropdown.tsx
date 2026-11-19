import { type KeyboardEvent, useRef } from "react";
import { Icon, type IconName } from "../Icon/Icon.tsx";
import { IconButton } from "../IconButton/IconButton.tsx";
import { Popover } from "../Popover/Popover.tsx";
import styles from "./Dropdown.module.css";

export type DropdownItem = {
    readonly label: string;
    readonly onSelect: () => void;
    readonly icon?: IconName;
    // danger: stops or removes something.
    readonly tone?: "plain" | "danger";
};

const ITEM = '[role="menuitem"]';

// A menu of actions behind an icon button. Opening puts focus on the first action; arrows, Home
// and End move between them; Esc closes and returns focus to the button (native, from the
// popover). Only the actions the caller is allowed to offer belong in `items`.
export function Dropdown({
    label,
    icon = "ellipsis",
    align = "end",
    items,
}: {
    // What the button is called for screen readers.
    readonly label: string;
    readonly icon?: IconName;
    readonly align?: "start" | "end";
    readonly items: readonly DropdownItem[];
}) {
    const menu = useRef<HTMLDivElement>(null);

    function entries(): readonly HTMLElement[] {
        return menu.current === null ? [] : [...menu.current.querySelectorAll<HTMLElement>(ITEM)];
    }

    function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const all = entries();
        const at = event.target instanceof HTMLElement ? all.indexOf(event.target) : -1;
        const move = (index: number) => {
            event.preventDefault();
            all[(index + all.length) % all.length]?.focus();
        };
        switch (event.key) {
            case "ArrowDown":
                return move(at + 1);
            case "ArrowUp":
                return move(at < 0 ? -1 : at - 1);
            case "Home":
                return move(0);
            case "End":
                return move(-1);
            case "Tab":
                return event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
        }
    }

    return (
        <Popover
            align={align}
            flush
            trigger={(popoverTarget) => (
                <IconButton icon={icon} label={label} popoverTarget={popoverTarget} />
            )}
            onOpen={() => entries()[0]?.focus()}
        >
            <div
                ref={menu}
                role="menu"
                aria-label={label}
                className={styles.menu}
                onKeyDown={onKeyDown}
            >
                {items.map((item) => (
                    <button
                        key={item.label}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className={styles.item}
                        data-tone={item.tone ?? "plain"}
                        onClick={(event) => {
                            event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                            item.onSelect();
                        }}
                    >
                        {item.icon === undefined ? null : <Icon name={item.icon} />}
                        {item.label}
                    </button>
                ))}
            </div>
        </Popover>
    );
}
