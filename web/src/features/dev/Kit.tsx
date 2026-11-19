import { EpochMs } from "@lucent/core/scalars";
import { type ReactNode, useState } from "react";
import { Button } from "../../ui/Button/Button.tsx";
import { Check } from "../../ui/Check/Check.tsx";
import { Code } from "../../ui/Code/Code.tsx";
import { CodeInput } from "../../ui/CodeInput/CodeInput.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Dropdown } from "../../ui/Dropdown/Dropdown.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { ExternalLink } from "../../ui/ExternalLink/ExternalLink.tsx";
import { Icon } from "../../ui/Icon/Icon.tsx";
import { ICON_NAMES } from "../../ui/Icon/names.ts";
import { IconButton } from "../../ui/IconButton/IconButton.tsx";
import { Ident } from "../../ui/Ident/Ident.tsx";
import { NewPassword } from "../../ui/NewPassword/NewPassword.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pager } from "../../ui/Pager/Pager.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Popover } from "../../ui/Popover/Popover.tsx";
import { Refusal } from "../../ui/Refusal/Refusal.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Switch } from "../../ui/Switch/Switch.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { TimeProvider } from "../../ui/Time/TimeProvider.tsx";
import { ToastProvider, useToast } from "../../ui/Toast/Toast.tsx";
import { Tooltip } from "../../ui/Tooltip/Tooltip.tsx";
import { THEME_NAMES } from "../../ui/tokens.ts";
import styles from "./Kit.module.css";

// Every building block in every state, in both themes side by side: where design review
// happens. Dev builds only (routes/_dev.tsx). The specimen text is sample data, not copy.

type SampleRow = {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly at: EpochMs;
};

function sampleRows(now: EpochMs): readonly SampleRow[] {
    return [
        {
            id: "acc_7Qm2Lx9PZt4Wv0yHcR1kSa",
            name: "alice",
            status: "active",
            at: EpochMs.parse(now - 5 * 60_000),
        },
        {
            id: "acc_0bN5eTqY3uJr8Dk2Vw6sLp",
            name: "bob",
            status: "suspended",
            at: EpochMs.parse(now - 26 * 3_600_000),
        },
        {
            id: "acc_Hh4Gf2Dd8Ss6Aa0Pp1Oo3I",
            name: "—",
            status: "setup pending",
            at: EpochMs.parse(now - 9 * 86_400_000),
        },
    ];
}

function Actions() {
    const [dialog, setDialog] = useState(false);
    const toast = useToast();
    return (
        <Section caption="Actions">
            <Stack direction="row" gap={2}>
                <Button tone="pink" icon="plus">
                    Add account
                </Button>
                <Button>Rename</Button>
                <Button tone="ghost">Cancel</Button>
                <Button tone="danger" icon="ban">
                    Suspend
                </Button>
                <Button pending>Saving</Button>
                <Button disabled>Disabled</Button>
            </Stack>
            <Stack direction="row" gap={2}>
                <Button tone="pink" size="sm">
                    Small
                </Button>
                <Button size="sm">Small</Button>
                <Tooltip text="More actions">
                    <IconButton icon="ellipsis" label="More" />
                </Tooltip>
                <IconButton icon="x" label="Close" size="sm" />
                <Dropdown
                    label="Account actions"
                    items={[
                        { label: "Rename", icon: "pencil", onSelect: () => toast("Renamed") },
                        {
                            label: "Recover",
                            icon: "rotate-ccw",
                            onSelect: () => toast("Recovered"),
                        },
                        {
                            label: "Suspend",
                            icon: "ban",
                            tone: "danger",
                            onSelect: () => toast("Suspended"),
                        },
                    ]}
                />
                <Popover trigger={(target) => <Button popoverTarget={target}>Popover</Button>}>
                    <p>A panel anchored to its trigger.</p>
                </Popover>
                <Button onClick={() => setDialog(true)}>Dialog</Button>
                <Button onClick={() => toast("Session ended")}>Toast</Button>
            </Stack>
            <Dialog
                open={dialog}
                onClose={() => setDialog(false)}
                title="Suspend alice"
                actions={
                    <>
                        <Button tone="ghost" onClick={() => setDialog(false)}>
                            Cancel
                        </Button>
                        <Button tone="danger" onClick={() => setDialog(false)}>
                            Suspend
                        </Button>
                    </>
                }
            >
                <p>They're signed out everywhere and can't sign in until reinstated.</p>
            </Dialog>
        </Section>
    );
}

function Inputs() {
    return (
        <Section caption="Inputs">
            <form className={styles.form} noValidate onSubmit={(event) => event.preventDefault()}>
                <Stack gap={4}>
                    <TextField
                        name="username"
                        label="Username"
                        hint="3 to 24 letters, digits or _"
                        required
                    />
                    <TextField
                        name="email"
                        label="Email"
                        type="email"
                        error="That email has an account."
                    />
                    <NewPassword name="password" label="New password" />
                    <CodeInput name="code" label="Code" hint="From your authenticator app" />
                    <Check name="remember" label="Keep this one" />
                    <Check name="inert" label="Inert" disabled />
                    <Switch name="notify" label="Notify me" />
                    <Refusal>That code didn't match. Try the next one.</Refusal>
                    <Refusal reference="7KQ2-M9XD">Something went wrong on our side.</Refusal>
                    <Stack direction="row" gap={2}>
                        <Button tone="pink" type="submit">
                            Continue
                        </Button>
                    </Stack>
                </Stack>
            </form>
        </Section>
    );
}

function Data({ now }: { readonly now: EpochMs }) {
    const rows = sampleRows(now);
    return (
        <Section caption="Data">
            <Pairs
                items={[
                    { label: "Username", value: "alice" },
                    { label: "Id", value: <Ident value="acc_7Qm2Lx9PZt4Wv0yHcR1kSa" /> },
                    { label: "Status", value: <Status icon="check">active</Status> },
                    { label: "Created", value: <Time at={rows[2]?.at ?? now} /> },
                    {
                        label: "Docs",
                        value: <ExternalLink href="https://lucide.dev">lucide.dev</ExternalLink>,
                    },
                ]}
            />
            <Table
                caption="Accounts"
                columns={[
                    { key: "name", header: "Username", cell: (row: SampleRow) => row.name },
                    { key: "id", header: "Id", cell: (row: SampleRow) => <Ident value={row.id} /> },
                    {
                        key: "status",
                        header: "Status",
                        cell: (row: SampleRow) => (
                            <Status
                                tone={
                                    row.status === "suspended"
                                        ? "shu"
                                        : row.status === "active"
                                          ? "neutral"
                                          : "pink"
                                }
                            >
                                {row.status}
                            </Status>
                        ),
                    },
                    {
                        key: "seen",
                        header: "Last seen",
                        align: "end",
                        cell: (row: SampleRow) => <Time at={row.at} format="relative" />,
                    },
                ]}
                rows={rows}
                rowKey={(row) => row.id}
            />
            <Pager nextCursor="next" onNext={() => undefined} />
            <Code>moon run server:seed -- recover-root</Code>
            <Empty action={<Button size="sm">Add account</Button>}>No accounts match.</Empty>
        </Section>
    );
}

function Icons() {
    return (
        <Section caption="Icons">
            <div className={styles.icons}>
                {ICON_NAMES.map((name) => (
                    <span key={name} className={styles.icon} title={name}>
                        <Icon name={name} size={20} />
                    </span>
                ))}
            </div>
        </Section>
    );
}

function Themed({ children }: { readonly children: ReactNode }) {
    return (
        <div className={styles.themes}>
            {THEME_NAMES.map((theme) => (
                <div key={theme} className={styles.pane} data-theme={theme}>
                    <p className={styles.theme}>{theme}</p>
                    {children}
                </div>
            ))}
        </div>
    );
}

export function Kit({ now }: { readonly now: EpochMs }) {
    return (
        <TimeProvider now={now} timeZone="Europe/Berlin">
            <ToastProvider>
                <Page title="Kit">
                    <Themed>
                        <Stack gap={6}>
                            <Actions />
                            <Inputs />
                            <Data now={now} />
                            <Icons />
                        </Stack>
                    </Themed>
                </Page>
            </ToastProvider>
        </TimeProvider>
    );
}
