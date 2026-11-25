import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { DEVICES_COPY } from "../../devices/copy.ts";
import { ACCOUNTS_COPY } from "./copy.ts";
import type { fetchAccount } from "./server.ts";

type Account = Awaited<ReturnType<typeof fetchAccount>>;
type Device = Account["devices"][number];

// The account's live PCs as staff see them, software-backed keys marked, and when the member may
// next change one themselves.
export function AccountDevices({ account }: { readonly account: Account }) {
    return (
        <Section caption={ACCOUNTS_COPY.devices}>
            <Stack gap={3}>
                {account.devices.length === 0 ? (
                    <Empty>{ACCOUNTS_COPY.noDevices}</Empty>
                ) : (
                    <Table
                        caption={ACCOUNTS_COPY.devices}
                        columns={[
                            {
                                key: "name",
                                header: DEVICES_COPY.name,
                                cell: (d: Device) => d.name ?? DEVICES_COPY.unnamed,
                            },
                            { key: "code", header: DEVICES_COPY.code, cell: (d) => d.matchCode },
                            {
                                key: "key",
                                header: DEVICES_COPY.key,
                                cell: (d) =>
                                    d.storage === "tpm" ? (
                                        <Status icon="shield-check">{DEVICES_COPY.tpm}</Status>
                                    ) : (
                                        <Status icon="lock">{DEVICES_COPY.software}</Status>
                                    ),
                            },
                            {
                                key: "added",
                                header: DEVICES_COPY.enrolled,
                                cell: (d) => <Time at={d.enrolledAt} />,
                            },
                            {
                                key: "seen",
                                header: DEVICES_COPY.lastSeen,
                                align: "end",
                                cell: (d) =>
                                    d.lastSeenAt === null ? (
                                        DEVICES_COPY.never
                                    ) : (
                                        <Time at={d.lastSeenAt} format="relative" />
                                    ),
                            },
                        ]}
                        rows={account.devices}
                        rowKey={(d) => d.deviceId}
                    />
                )}
                <p>
                    {ACCOUNTS_COPY.nextChange}{" "}
                    {account.replaceableFrom === null ? (
                        ACCOUNTS_COPY.now
                    ) : (
                        <Time at={account.replaceableFrom} />
                    )}
                </p>
            </Stack>
        </Section>
    );
}
