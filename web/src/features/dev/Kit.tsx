import { type EpochMs, isEpochMs } from "@lucent/core/brands";
import { invariant } from "@lucent/core/contain";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Button } from "../../ui/Button/Button.tsx";
import { Check } from "../../ui/Check/Check.tsx";
import { Code } from "../../ui/Code/Code.tsx";
import { CodeInput } from "../../ui/CodeInput/CodeInput.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Dropdown } from "../../ui/Dropdown/Dropdown.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { ExternalLink } from "../../ui/ExternalLink/ExternalLink.tsx";
import { Icon } from "../../ui/Icon/Icon.tsx";
import { ICON_NAMES } from "../../ui/Icon/names.ts";
import { IconButton } from "../../ui/IconButton/IconButton.tsx";
import { Ident } from "../../ui/Ident/Ident.tsx";
import { Logo } from "../../ui/Logo/Logo.tsx";
import { NewPassword } from "../../ui/NewPassword/NewPassword.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pager } from "../../ui/Pager/Pager.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Popover } from "../../ui/Popover/Popover.tsx";
import { ProductPick } from "../../ui/ProductPick/ProductPick.tsx";
import { Refusal } from "../../ui/Refusal/Refusal.tsx";
import { RoleLabel } from "../../ui/RoleLabel/RoleLabel.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Switch } from "../../ui/Switch/Switch.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { Tabs } from "../../ui/Tabs/Tabs.tsx";
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

function ago(now: EpochMs, ms: number): EpochMs {
    const at = now - ms;
    invariant(isEpochMs(at), "a sample time is after 1970");
    return at;
}

function sampleRows(now: EpochMs): readonly SampleRow[] {
    return [
        {
            id: "acc_7Qm2Lx9PZt4Wv0yHcR1kSa",
            name: "alice",
            status: "active",
            at: ago(now, 5 * 60_000),
        },
        {
            id: "acc_0bN5eTqY3uJr8Dk2Vw6sLp",
            name: "bob",
            status: "suspended",
            at: ago(now, 26 * 3_600_000),
        },
        {
            id: "acc_Hh4Gf2Dd8Ss6Aa0Pp1Oo3I",
            name: "—",
            status: "setup pending",
            at: ago(now, 9 * 86_400_000),
        },
    ];
}

function Actions() {
    const [dialog, setDialog] = useState(false);
    const toast = useToast();
    return (
        <Section caption="actions">
            <Stack direction="row" gap={2}>
                <Button tone="pink" icon="plus">
                    add account
                </Button>
                <Button>rename</Button>
                <Button tone="ghost">cancel</Button>
                <Button tone="danger" icon="ban">
                    suspend
                </Button>
                <Button pending>saving</Button>
                <Button disabled>disabled</Button>
            </Stack>
            <Stack direction="row" gap={2}>
                <Button tone="pink" size="sm">
                    small
                </Button>
                <Button size="sm">small</Button>
                <Tooltip text="more actions">
                    <IconButton icon="ellipsis" label="more" />
                </Tooltip>
                <IconButton icon="x" label="close" size="sm" />
                <Dropdown
                    label="account actions"
                    items={[
                        { label: "rename", icon: "pencil", onSelect: () => toast("renamed") },
                        {
                            label: "recover",
                            icon: "rotate-ccw",
                            onSelect: () => toast("recovered"),
                        },
                        {
                            label: "suspend",
                            icon: "ban",
                            tone: "danger",
                            onSelect: () => toast("suspended"),
                        },
                    ]}
                />
                <Popover trigger={(target) => <Button popoverTarget={target}>popover</Button>}>
                    <p>a panel anchored to its trigger.</p>
                </Popover>
                <Button onClick={() => setDialog(true)}>dialog</Button>
                <Button onClick={() => toast("session ended")}>toast</Button>
            </Stack>
            <Dialog
                open={dialog}
                onClose={() => setDialog(false)}
                title="suspend alice"
                actions={
                    <>
                        <Button tone="ghost" onClick={() => setDialog(false)}>
                            cancel
                        </Button>
                        <Button tone="danger" onClick={() => setDialog(false)}>
                            suspend
                        </Button>
                    </>
                }
            >
                <p>they're signed out everywhere and can't sign in until reinstated.</p>
            </Dialog>
        </Section>
    );
}

function Inputs() {
    return (
        <Section caption="inputs">
            <form className={styles.form} noValidate onSubmit={(event) => event.preventDefault()}>
                <Stack gap={4}>
                    <TextField
                        name="username"
                        label="username"
                        hint="3 to 24 letters, digits or _"
                        required
                    />
                    <TextField
                        name="email"
                        label="email"
                        type="email"
                        error="That email has an account."
                    />
                    <NewPassword name="password" label="new password" />
                    <CodeInput name="code" label="code" hint="From your authenticator app" />
                    <Check name="remember" label="keep this one" />
                    <Check name="inert" label="inert" disabled />
                    <Switch name="notify" label="notify me" />
                    <Refusal>that code didn't match. try the next one.</Refusal>
                    <Refusal reference="7KQ2-M9XD">something went wrong on our side.</Refusal>
                    <Stack direction="row" gap={2}>
                        <Button tone="pink" type="submit">
                            continue
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
        <Section caption="data">
            <Pairs
                items={[
                    { label: "username", value: "alice" },
                    { label: "id", value: <Ident value="acc_7Qm2Lx9PZt4Wv0yHcR1kSa" /> },
                    { label: "status", value: <Status icon="check">active</Status> },
                    { label: "created", value: <Time at={rows[2]?.at ?? now} /> },
                    {
                        label: "docs",
                        value: <ExternalLink href="https://lucide.dev">lucide.dev</ExternalLink>,
                    },
                ]}
            />
            <Pairs
                align="end"
                items={[
                    { label: "support", value: "supported", tone: "ok" },
                    { label: "while a patch lands", value: "updating", tone: "wait" },
                    { label: "before it is out", value: "early access", tone: "dim" },
                    { label: "your access", value: "until 3 jan 2027" },
                ]}
            />
            <Stack direction="row" gap={3} align="center">
                <RoleLabel name="staff" color="pink" />
                <RoleLabel name="moderator" color="shu" />
                <RoleLabel name="guide" color="ok" />
                <RoleLabel name="trial" color="wait" />
                <RoleLabel name="artist" color="violet" />
                <RoleLabel name="helper" color="aqua" />
            </Stack>
            <Table
                caption="accounts"
                columns={[
                    { key: "name", header: "username", cell: (row: SampleRow) => row.name },
                    { key: "id", header: "id", cell: (row: SampleRow) => <Ident value={row.id} /> },
                    {
                        key: "status",
                        header: "status",
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
                        header: "last seen",
                        align: "end",
                        cell: (row: SampleRow) => <Time at={row.at} format="relative" />,
                    },
                ]}
                rows={rows}
                rowKey={(row) => row.id}
            />
            <Stack direction="row" gap={2} align="center">
                <Status tone="ok">supported</Status>
                <Status tone="wait">updating</Status>
                <Status tone="shu">stopped</Status>
            </Stack>
            <Tabs
                tabs={[
                    { to: "/dev/kit", label: "changes" },
                    { to: "/dev/kit", label: "docs" },
                    { to: "/dev/kit", label: "cloud" },
                ]}
            />
            <h1>
                <ProductPick
                    label="counter-strike 2"
                    current="cs2"
                    rows={[
                        {
                            id: "cs2",
                            label: "counter-strike 2",
                            status: { word: "supported", tone: "ok" },
                        },
                        {
                            id: "dota2",
                            label: "dota 2",
                            status: { word: "updating", tone: "wait" },
                        },
                        { id: "tf2", label: "team fortress 2", status: "no-access" },
                    ]}
                    linkFor={(_id, children) => <Link to="/dev/kit">{children}</Link>}
                />
            </h1>
            <Pager nextCursor="next" onNext={() => undefined} />
            <Code>moon run server:seed -- recover-root</Code>
            <Empty action={<Button size="sm">add account</Button>}>no accounts match.</Empty>
        </Section>
    );
}

function Icons() {
    return (
        <Section caption="icons">
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

function Frame() {
    return (
        <Stack gap={6}>
            <Section caption="logo">
                <Stack direction="row" gap={5}>
                    <Logo />
                    <Logo size="landing" />
                </Stack>
            </Section>
            <Columns
                main={
                    <Section caption="wide column">
                        <p>the head row above and these captions share one height.</p>
                    </Section>
                }
                aside={
                    <Section caption="444px column">
                        <p>both start at the same height; no hairline crosses the gap.</p>
                    </Section>
                }
            />
        </Stack>
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
                <Page title="kit">
                    <Themed>
                        <Stack gap={6}>
                            <Actions />
                            <Inputs />
                            <Data now={now} />
                            <Icons />
                        </Stack>
                    </Themed>
                    <Frame />
                </Page>
            </ToastProvider>
        </TimeProvider>
    );
}
