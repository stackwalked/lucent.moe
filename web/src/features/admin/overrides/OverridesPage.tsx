import { getRouteApi, Link } from "@tanstack/react-router";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Ident } from "../../../ui/Ident/Ident.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { OVERRIDES_COPY } from "./copy.ts";
import { setOverride } from "./switch.ts";

const route = getRouteApi("/_admin/admin/products/overrides/$releaseId");

type Listed = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Feature = Listed["features"][number];
type Capability = Listed["capabilities"][number];
type Switch = Listed["switches"][number];

// One module release's kill switches: each feature and capability its manifest declares, and
// whether staff turned it off for every session on the release.
export function OverridesPage() {
    const listed = route.useLoaderData();
    const { releaseId } = route.useParams();
    const trail = <Link to="/admin/products/overrides">{OVERRIDES_COPY.title}</Link>;
    if (!listed.ok) {
        return (
            <Page title={OVERRIDES_COPY.title} trail={trail}>
                <RefusalNote refused={listed.refused} />
            </Page>
        );
    }
    const { features, capabilities, switches } = listed.value;
    const switchOf = (kind: Switch["kind"], key: string) =>
        switches.find((row) => row.kind === kind && row.key === key) ?? null;
    return (
        <Page title={OVERRIDES_COPY.title} trail={trail}>
            <Section caption={OVERRIDES_COPY.release}>
                <Ident value={releaseId} />
            </Section>
            <Section caption={OVERRIDES_COPY.features}>
                {features.length === 0 ? (
                    <Empty>{OVERRIDES_COPY.noFeatures}</Empty>
                ) : (
                    <Table
                        caption={OVERRIDES_COPY.features}
                        columns={[
                            {
                                key: "feature",
                                header: OVERRIDES_COPY.feature,
                                cell: (row: Feature) => row.tag,
                            },
                            {
                                key: "key",
                                header: OVERRIDES_COPY.key,
                                cell: (row) => <Ident value={row.key} />,
                            },
                            {
                                key: "state",
                                header: OVERRIDES_COPY.state,
                                cell: (row) => (
                                    <SwitchState switched={switchOf("feature", row.key)} />
                                ),
                            },
                            {
                                key: "actions",
                                header: "",
                                align: "end",
                                cell: (row) => (
                                    <Toggle
                                        releaseId={releaseId}
                                        kind="feature"
                                        keyHex={row.key}
                                        name={row.tag}
                                        off={row.off}
                                        core={false}
                                    />
                                ),
                            },
                        ]}
                        rows={features}
                        rowKey={(row) => row.key}
                    />
                )}
            </Section>
            <Section caption={OVERRIDES_COPY.capabilities}>
                {capabilities.length === 0 ? (
                    <Empty>{OVERRIDES_COPY.noCapabilities}</Empty>
                ) : (
                    <Table
                        caption={OVERRIDES_COPY.capabilities}
                        columns={[
                            {
                                key: "capability",
                                header: OVERRIDES_COPY.capability,
                                cell: (row: Capability) => <Ident value={row.key} />,
                            },
                            {
                                key: "level",
                                header: OVERRIDES_COPY.level,
                                cell: (row) =>
                                    row.level === "core"
                                        ? OVERRIDES_COPY.core
                                        : OVERRIDES_COPY.optional,
                            },
                            {
                                key: "state",
                                header: OVERRIDES_COPY.state,
                                cell: (row) => (
                                    <SwitchState switched={switchOf("capability", row.key)} />
                                ),
                            },
                            {
                                key: "actions",
                                header: "",
                                align: "end",
                                cell: (row) => (
                                    <Toggle
                                        releaseId={releaseId}
                                        kind="capability"
                                        keyHex={row.key}
                                        name={row.key}
                                        off={row.off}
                                        core={row.level === "core"}
                                    />
                                ),
                            },
                        ]}
                        rows={capabilities}
                        rowKey={(row) => row.key}
                    />
                )}
            </Section>
        </Page>
    );
}

function SwitchState({ switched }: { readonly switched: Switch | null }) {
    if (switched === null) return OVERRIDES_COPY.on;
    return (
        <span>
            <Status tone="shu">{OVERRIDES_COPY.off}</Status>{" "}
            <Who
                accountId={switched.setBy.id}
                username={switched.setBy.username}
                pending={ADMIN_COPY.pending}
            />{" "}
            <Time at={switched.setAt} />
        </span>
    );
}

// The route is guarded by facts:override, so whoever sees the page may switch.
function Toggle(props: {
    readonly releaseId: string;
    readonly kind: "feature" | "capability";
    readonly keyHex: string;
    readonly name: string;
    readonly off: boolean;
    readonly core: boolean;
}) {
    const turningOff = !props.off;
    return (
        <AccountAction
            action="facts:override"
            label={turningOff ? OVERRIDES_COPY.turnOff : OVERRIDES_COPY.turnOn}
            title={
                turningOff
                    ? OVERRIDES_COPY.turnOffTitle(props.name)
                    : OVERRIDES_COPY.turnOnTitle(props.name)
            }
            tone={turningOff ? "danger" : "plain"}
            fields={
                <p>
                    {turningOff
                        ? props.core
                            ? OVERRIDES_COPY.turnOffCoreBody
                            : OVERRIDES_COPY.turnOffBody
                        : OVERRIDES_COPY.turnOnBody}
                </p>
            }
            run={() =>
                setOverride({
                    data: {
                        releaseId: props.releaseId,
                        kind: props.kind,
                        key: props.keyHex,
                        off: turningOff,
                    },
                })
            }
        />
    );
}
