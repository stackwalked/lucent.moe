import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../../ui/Icon/Icon.tsx";
import { ADMIN_COPY as C } from "../copy.ts";
import styles from "./AdminSearch.module.css";
import { searchStaff } from "./server.ts";

type Found = Extract<Awaited<ReturnType<typeof searchStaff>>, { readonly ok: true }>["value"];
type Hit = {
    readonly key: string;
    readonly kind: keyof typeof C.kinds;
    readonly label: string;
    readonly open: () => void;
};

const DEBOUNCE_MS = 200;

// The staff box in the bar: what is typed goes to `admin.search` once typing pauses, the latest
// answer wins, and the hits list under the box by kind. Arrow keys move through them, Enter opens
// one, Esc closes. Every hit opens an account or a ticket.
export function AdminSearch() {
    const router = useRouter();
    const id = useId();
    const panel = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const latest = useRef(0);
    const [text, setText] = useState("");
    const [found, setFound] = useState<Found | null>(null);
    const [active, setActive] = useState(0);
    const [collapsed, setCollapsed] = useState(true);

    const hits: readonly Hit[] =
        found === null
            ? []
            : [
                  ...found.accounts.map((row) => ({
                      key: `a-${row.id}`,
                      kind: "accounts" as const,
                      label: row.username ?? row.email,
                      open: () =>
                          void router.navigate({
                              to: "/admin/members/accounts/$accountId",
                              params: { accountId: row.id },
                          }),
                  })),
                  ...found.pcs.map((row) => ({
                      key: `p-${row.id}-${row.accountId}`,
                      kind: "pcs" as const,
                      label: `${row.id} ${row.username ?? ""}`.trim(),
                      open: () =>
                          void router.navigate({
                              to: "/admin/members/accounts/$accountId",
                              params: { accountId: row.accountId },
                          }),
                  })),
                  ...found.invites.map((row) => ({
                      key: `i-${row.inviterId}`,
                      kind: "invites" as const,
                      label: row.inviterUsername ?? row.inviterId,
                      open: () =>
                          void router.navigate({
                              to: "/admin/members/accounts/$accountId",
                              params: { accountId: row.inviterId },
                          }),
                  })),
                  ...found.tickets.map((row) => ({
                      key: `t-${row.id}`,
                      kind: "tickets" as const,
                      label: `${row.subject ?? C.kinds.tickets} ${row.username ?? ""}`.trim(),
                      open: () =>
                          void router.navigate({
                              to: "/admin/queue/tickets/$ticketId",
                              params: { ticketId: row.id },
                          }),
                  })),
              ];

    useEffect(() => {
        const element = panel.current;
        if (element === null) return;
        const wanted = found !== null && text.trim() !== "";
        if (wanted && !element.matches(":popover-open")) element.showPopover();
        if (!wanted && element.matches(":popover-open")) element.hidePopover();
    }, [found, text]);

    const change = (value: string) => {
        setText(value);
        setActive(0);
        const ticket = latest.current + 1;
        latest.current = ticket;
        if (value.trim() === "") return setFound(null);
        setTimeout(async () => {
            if (latest.current !== ticket) return;
            const reply = await searchStaff({ data: { text: value } });
            if (latest.current === ticket && reply.ok) setFound(reply.value);
        }, DEBOUNCE_MS);
    };
    const close = () => {
        latest.current += 1;
        setFound(null);
        setText("");
    };
    const choose = (hit: Hit | undefined) => {
        if (hit === undefined) return;
        hit.open();
        close();
        input.current?.blur();
    };

    return (
        <search className={styles.search} data-collapsed={collapsed}>
            <button
                type="button"
                className={styles.opener}
                aria-label={C.search}
                onClick={() => {
                    setCollapsed(false);
                    queueMicrotask(() => input.current?.focus());
                }}
            >
                <Icon name="search" size={16} />
            </button>
            <input
                ref={input}
                className={styles.input}
                type="search"
                role="combobox"
                aria-label={C.search}
                aria-expanded={found !== null && text.trim() !== ""}
                aria-controls={id}
                placeholder={C.search}
                autoComplete="off"
                maxLength={120}
                value={text}
                onChange={(event) => change(event.currentTarget.value)}
                onBlur={() => setCollapsed(true)}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && hits.length > 0) {
                        event.preventDefault();
                        setActive((at) => (at + 1) % hits.length);
                    } else if (event.key === "ArrowUp" && hits.length > 0) {
                        event.preventDefault();
                        setActive((at) => (at - 1 + hits.length) % hits.length);
                    } else if (event.key === "Enter") {
                        event.preventDefault();
                        choose(hits[active]);
                    } else if (event.key === "Escape") {
                        close();
                    }
                }}
            />
            <div id={id} ref={panel} popover="manual" className={styles.panel} role="listbox">
                {found !== null && hits.length === 0 ? (
                    <p className={styles.none}>{C.noResults}</p>
                ) : (
                    (["accounts", "pcs", "invites", "tickets"] as const).map((kind) => {
                        const rows = hits.filter((hit) => hit.kind === kind);
                        return rows.length === 0 ? null : (
                            <div key={kind} className={styles.group}>
                                <p className={styles.kind}>{C.kinds[kind]}</p>
                                {rows.map((hit) => (
                                    <button
                                        key={hit.key}
                                        type="button"
                                        role="option"
                                        aria-selected={hits[active]?.key === hit.key}
                                        className={styles.hit}
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => choose(hit)}
                                    >
                                        {hit.label}
                                    </button>
                                ))}
                            </div>
                        );
                    })
                )}
            </div>
        </search>
    );
}
