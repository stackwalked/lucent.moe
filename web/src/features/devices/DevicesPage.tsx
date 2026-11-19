import { systemCryptoRng } from "@lucent/core/rng";
import { newOperationId, type OperationId } from "@lucent/core/scalars";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useActionState, useId, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { Table } from "../../ui/Table/Table.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { useToast } from "../../ui/Toast/Toast.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { useStepUp } from "../step-up/StepUp.tsx";
import { approvalChange, mayRemove } from "./change.ts";
import { DEVICES_COPY } from "./copy.ts";
import { approveEnrollment, denyEnrollment, removeDevice, renameDevice } from "./server.ts";

const route = getRouteApi("/_member/account/devices");

type Loaded = Extract<ReturnType<typeof route.useLoaderData>, { ok: true }>["value"];
type Device = Loaded["devices"][number];
type Enrollment = Loaded["enrollments"][number];

function nameOf(device: Device): string {
    return device.name ?? DEVICES_COPY.unnamed;
}

function Storage({ storage }: { readonly storage: Device["storage"] }) {
    if (storage === "tpm") return <Status icon="shield-check">{DEVICES_COPY.tpm}</Status>;
    return <Status icon="lock">{DEVICES_COPY.software}</Status>;
}

// One waiting PC: approving binds it, so it asks for a recent proof (the step-up dialog, or a
// fresh sign-in without a passkey) and is sent again with the same operationId after it.
function Waiting({ enrollment, list }: { readonly enrollment: Enrollment; readonly list: Loaded }) {
    const router = useRouter();
    const guard = useStepUp();
    const toast = useToast();
    const [operationId] = useState(() => newOperationId(systemCryptoRng));
    const [refused, setRefused] = useState<Refused | null>(null);
    const [pending, setPending] = useState<"approve" | "deny" | null>(null);
    const change = approvalChange(list);

    const act = async <T,>(
        which: "approve" | "deny",
        run: () => Promise<Outcome<T>>,
        said: (value: T) => string,
    ) => {
        setPending(which);
        setRefused(null);
        const reply = await run();
        setPending(null);
        if (!reply.ok) return setRefused(reply.refused);
        toast(said(reply.value));
        await router.invalidate();
    };

    return (
        <Stack gap={3}>
            <Stack direction="row" gap={3} align="center">
                <Status tone="pink">{enrollment.matchCode}</Status>
                <Storage storage={enrollment.storage} />
                <span>
                    {DEVICES_COPY.asked} <Time at={enrollment.createdAt} format="relative" />
                </span>
            </Stack>
            {change.kind === "waits" ? (
                <p>
                    {DEVICES_COPY.waitsUntil} <Time at={change.until} />
                </p>
            ) : (
                <p>{change.kind === "adds" ? DEVICES_COPY.adds : DEVICES_COPY.replaces}</p>
            )}
            <RefusalNote refused={refused} overrides={{ FORBIDDEN: DEVICES_COPY.alreadyThere }} />
            <Stack direction="row" gap={2}>
                {change.kind === "waits" ? null : (
                    <Button
                        tone="pink"
                        pending={pending === "approve"}
                        onClick={() =>
                            void act(
                                "approve",
                                () =>
                                    guard(() =>
                                        approveEnrollment({
                                            data: {
                                                operationId,
                                                enrollmentId: enrollment.enrollmentId,
                                            },
                                        }),
                                    ),
                                (approved) =>
                                    approved.replaced
                                        ? DEVICES_COPY.replacedOne
                                        : DEVICES_COPY.approved,
                            )
                        }
                    >
                        {DEVICES_COPY.approve}
                    </Button>
                )}
                <Button
                    pending={pending === "deny"}
                    onClick={() =>
                        void act(
                            "deny",
                            () =>
                                denyEnrollment({
                                    data: { enrollmentId: enrollment.enrollmentId },
                                }),
                            () => DEVICES_COPY.denied,
                        )
                    }
                >
                    {DEVICES_COPY.deny}
                </Button>
            </Stack>
        </Stack>
    );
}

function Rename({ device }: { readonly device: Device }) {
    const router = useRouter();
    const toast = useToast();
    const formId = useId();
    const [open, setOpen] = useState(false);
    const [refused, submit, pending] = useActionState(async (_: Refused | null, form: FormData) => {
        const reply = await renameDevice({
            data: { deviceId: device.deviceId, name: String(form.get("name") ?? "") },
        });
        if (!reply.ok) return reply.refused;
        setOpen(false);
        toast(DEVICES_COPY.renamed);
        await router.invalidate();
        return null;
    }, null);
    return (
        <>
            <Button size="sm" tone="ghost" icon="pencil" onClick={() => setOpen(true)}>
                {DEVICES_COPY.rename}
            </Button>
            <Dialog
                open={open}
                onClose={() => setOpen(false)}
                title={DEVICES_COPY.renameTitle(nameOf(device))}
                busy={pending}
                actions={
                    <>
                        <Button tone="ghost" disabled={pending} onClick={() => setOpen(false)}>
                            {DEVICES_COPY.cancel}
                        </Button>
                        <Button tone="pink" type="submit" form={formId} pending={pending}>
                            {DEVICES_COPY.save}
                        </Button>
                    </>
                }
            >
                <form id={formId} action={submit} noValidate>
                    <fieldset disabled={pending}>
                        <Stack gap={3}>
                            <TextField
                                name="name"
                                label={DEVICES_COPY.newName}
                                hint={DEVICES_COPY.newNameHint}
                                maxLength={64}
                                defaultValue={device.name ?? ""}
                            />
                            <RefusalNote refused={refused} />
                        </Stack>
                    </fieldset>
                </form>
            </Dialog>
        </>
    );
}

// Each opening is one attempt with its own operationId, so the retry after a proof acts once.
function Remove({ device }: { readonly device: Device }) {
    const router = useRouter();
    const guard = useStepUp();
    const toast = useToast();
    const [operationId, setOperationId] = useState<OperationId | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    const [pending, setPending] = useState(false);
    const close = () => {
        setOperationId(null);
        setRefused(null);
    };
    const remove = async (opening: OperationId) => {
        setPending(true);
        setRefused(null);
        const reply = await guard(() =>
            removeDevice({ data: { operationId: opening, deviceId: device.deviceId } }),
        );
        setPending(false);
        if (!reply.ok) return setRefused(reply.refused);
        close();
        toast(DEVICES_COPY.removed);
        await router.invalidate();
    };
    return (
        <>
            <Button
                size="sm"
                tone="ghost"
                icon="trash-2"
                onClick={() => setOperationId(newOperationId(systemCryptoRng))}
            >
                {DEVICES_COPY.remove}
            </Button>
            <Dialog
                open={operationId !== null}
                onClose={close}
                title={DEVICES_COPY.removeTitle(nameOf(device))}
                busy={pending}
                actions={
                    <>
                        <Button tone="ghost" disabled={pending} onClick={close}>
                            {DEVICES_COPY.cancel}
                        </Button>
                        <Button
                            tone="danger"
                            pending={pending}
                            onClick={() => {
                                if (operationId !== null) void remove(operationId);
                            }}
                        >
                            {DEVICES_COPY.remove}
                        </Button>
                    </>
                }
            >
                <Stack gap={3}>
                    <p>{DEVICES_COPY.removeBody}</p>
                    <RefusalNote refused={refused} />
                </Stack>
            </Dialog>
        </>
    );
}

export function DevicesPage() {
    const loaded = route.useLoaderData();
    if (!loaded.ok) {
        return (
            <Page title={DEVICES_COPY.title} width="narrow">
                <RefusalNote refused={loaded.refused} />
            </Page>
        );
    }
    const list = loaded.value;
    const removable = mayRemove(list);
    return (
        <Page title={DEVICES_COPY.title} width="narrow">
            {list.enrollments.length === 0 ? null : (
                <Section caption={DEVICES_COPY.waiting}>
                    <Stack gap={4}>
                        <p>{DEVICES_COPY.waitingHint}</p>
                        {list.enrollments.map((enrollment) => (
                            <Waiting
                                key={enrollment.enrollmentId}
                                enrollment={enrollment}
                                list={list}
                            />
                        ))}
                    </Stack>
                </Section>
            )}
            <Section caption={DEVICES_COPY.yours}>
                {list.devices.length === 0 ? (
                    <Empty>{DEVICES_COPY.noDevices}</Empty>
                ) : (
                    <Table
                        caption={DEVICES_COPY.yours}
                        columns={[
                            {
                                key: "name",
                                header: DEVICES_COPY.name,
                                cell: (d: Device) => nameOf(d),
                            },
                            { key: "code", header: DEVICES_COPY.code, cell: (d) => d.matchCode },
                            {
                                key: "key",
                                header: DEVICES_COPY.key,
                                cell: (d) => <Storage storage={d.storage} />,
                            },
                            {
                                key: "added",
                                header: DEVICES_COPY.enrolled,
                                cell: (d) => <Time at={d.enrolledAt} />,
                            },
                            {
                                key: "seen",
                                header: DEVICES_COPY.lastSeen,
                                cell: (d) =>
                                    d.lastSeenAt === null ? (
                                        DEVICES_COPY.never
                                    ) : (
                                        <Time at={d.lastSeenAt} format="relative" />
                                    ),
                            },
                            {
                                key: "actions",
                                header: "",
                                align: "end",
                                cell: (d) => (
                                    <Stack direction="row" gap={1}>
                                        <Rename device={d} />
                                        {removable ? <Remove device={d} /> : null}
                                    </Stack>
                                ),
                            },
                        ]}
                        rows={list.devices}
                        rowKey={(d) => d.deviceId}
                    />
                )}
                {list.devices.some((d) => d.storage === "software") ? (
                    <p>{DEVICES_COPY.softwareHint}</p>
                ) : null}
            </Section>
            <Section caption={DEVICES_COPY.window}>
                {list.replaceableFrom === null ? (
                    <p>{DEVICES_COPY.windowOpen}</p>
                ) : (
                    <p>
                        {DEVICES_COPY.windowClosed} <Time at={list.replaceableFrom} />
                    </p>
                )}
            </Section>
        </Page>
    );
}
