import { newOperationId, type OperationId } from "@lucent/core/brands";
import { systemCryptoRng } from "@lucent/core/rng";
import { useRouter } from "@tanstack/react-router";
import { useActionState, useState } from "react";
import type { Outcome, Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Dialog } from "../../ui/Dialog/Dialog.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { RowAction, SettingRow, SettingRows } from "../../ui/SettingRow/SettingRow.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Status } from "../../ui/Status/Status.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { useToast } from "../../ui/Toast/Toast.tsx";
import { FormDialog } from "../account/FormDialog.tsx";
import { Note } from "../account/Note.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { useStepUp } from "../step-up/StepUp.tsx";
import { approvalChange, mayRemove } from "./change.ts";
import { DEVICES_COPY as C } from "./copy.ts";
import type { fetchDevices } from "./server.ts";
import { approveEnrollment, denyEnrollment, removeDevice, renameDevice } from "./server.ts";

type Loaded = Extract<Awaited<ReturnType<typeof fetchDevices>>, { ok: true }>["value"];
type Device = Loaded["devices"][number];
type Enrollment = Loaded["enrollments"][number];

function nameOf(device: Device): string {
    return device.name ?? C.unnamed;
}

function Storage({ storage }: { readonly storage: Device["storage"] }) {
    if (storage === "tpm") return <Status icon="shield-check">{C.tpm}</Status>;
    return <Status icon="lock">{C.software}</Status>;
}

// One waiting PC. Approving binds it, so it asks for a recent proof (the step-up dialog, or a
// fresh sign-in without a passkey) and is sent again with the same operationId after it.
function Waiting({
    enrollment,
    list,
    onRefused,
}: {
    readonly enrollment: Enrollment;
    readonly list: Loaded;
    readonly onRefused: (refused: Refused | null) => void;
}) {
    const router = useRouter();
    const guard = useStepUp();
    const toast = useToast();
    const [operationId] = useState(() => newOperationId(systemCryptoRng));
    const [open, setOpen] = useState(false);
    const [refused, setRefused] = useState<Refused | null>(null);
    const [pending, setPending] = useState<"approve" | "deny" | null>(null);
    const change = approvalChange(list);

    const approve = async () => {
        setPending("approve");
        setRefused(null);
        const reply = await guard(() =>
            approveEnrollment({ data: { operationId, enrollmentId: enrollment.enrollmentId } }),
        );
        setPending(null);
        if (!reply.ok) return setRefused(reply.refused);
        setOpen(false);
        toast(reply.value.replaced ? C.replacedOne : C.approved);
        await router.invalidate();
    };
    const deny = async () => {
        setPending("deny");
        onRefused(null);
        const reply = await denyEnrollment({ data: { enrollmentId: enrollment.enrollmentId } });
        setPending(null);
        if (!reply.ok) return onRefused(reply.refused);
        toast(C.denied);
        await router.invalidate();
    };

    return (
        <SettingRow
            layout="item"
            name={C.waiting}
            value={<Status tone="pink">{enrollment.matchCode}</Status>}
            action={
                <>
                    <RowAction
                        tone="quiet"
                        pending={pending === "deny"}
                        onClick={() => void deny()}
                    >
                        {C.deny}
                    </RowAction>
                    <RowAction tone="pink" onClick={() => setOpen(true)}>
                        {C.approve}
                    </RowAction>
                </>
            }
        >
            <Dialog
                open={open}
                onClose={() => setOpen(false)}
                title={C.approveTitle}
                busy={pending === "approve"}
                actions={
                    <>
                        <Button
                            tone="ghost"
                            disabled={pending === "approve"}
                            onClick={() => setOpen(false)}
                        >
                            {C.cancel}
                        </Button>
                        {change.kind === "waits" ? null : (
                            <Button
                                tone="pink"
                                pending={pending === "approve"}
                                onClick={() => void approve()}
                            >
                                {C.approve}
                            </Button>
                        )}
                    </>
                }
            >
                <Stack gap={3}>
                    <Stack direction="row" gap={3} align="center">
                        <Status tone="pink">{enrollment.matchCode}</Status>
                        <Storage storage={enrollment.storage} />
                    </Stack>
                    <p>{C.waitingCheck}</p>
                    {change.kind === "waits" ? (
                        <p>
                            {C.waits} <Time at={change.until} />
                        </p>
                    ) : (
                        <p>{change.kind === "adds" ? C.adds : C.replaces}</p>
                    )}
                    <RefusalNote refused={refused} overrides={{ FORBIDDEN: C.alreadyThere }} />
                </Stack>
            </Dialog>
        </SettingRow>
    );
}

function Rename({ device }: { readonly device: Device }) {
    const router = useRouter();
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [refused, submit, pending] = useActionState(async (_: Refused | null, form: FormData) => {
        const reply = await renameDevice({
            data: { deviceId: device.deviceId, name: String(form.get("name") ?? "") },
        });
        if (!reply.ok) return reply.refused;
        setOpen(false);
        toast(C.renamed);
        await router.invalidate();
        return null;
    }, null);
    return (
        <>
            <RowAction
                tone="quiet"
                label={C.renameLabel(nameOf(device))}
                onClick={() => setOpen(true)}
            >
                {C.rename}
            </RowAction>
            <FormDialog
                open={open}
                onClose={() => setOpen(false)}
                title={C.renameTitle(nameOf(device))}
                confirm={C.rename}
                pending={pending}
                action={submit}
            >
                <TextField
                    name="name"
                    label={C.newName}
                    maxLength={64}
                    defaultValue={device.name ?? ""}
                />
                <RefusalNote refused={refused} />
            </FormDialog>
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
        toast(C.removed);
        await router.invalidate();
    };
    return (
        <>
            <RowAction
                tone="quiet"
                label={C.removeLabel(nameOf(device))}
                onClick={() => setOperationId(newOperationId(systemCryptoRng))}
            >
                {C.remove}
            </RowAction>
            <Dialog
                open={operationId !== null}
                onClose={close}
                title={C.removeTitle(nameOf(device))}
                busy={pending}
                actions={
                    <>
                        <Button tone="ghost" disabled={pending} onClick={close}>
                            {C.cancel}
                        </Button>
                        <Button
                            tone="danger"
                            pending={pending}
                            onClick={() => {
                                if (operationId !== null) void remove(operationId);
                            }}
                        >
                            {C.remove}
                        </Button>
                    </>
                }
            >
                <Stack gap={3}>
                    <p>{C.removeBody}</p>
                    <RefusalNote refused={refused} />
                </Stack>
            </Dialog>
        </>
    );
}

// The member's PCs: when they last signed in and what can be done to each, with a PC waiting for
// approval first. The caption ends with when a PC may next be changed.
export function PcsSection({ devices }: { readonly devices: Outcome<Loaded> }) {
    const [refused, setRefused] = useState<Refused | null>(null);
    if (!devices.ok) {
        return (
            <Section caption={C.title}>
                <RefusalNote refused={devices.refused} />
            </Section>
        );
    }
    const list = devices.value;
    const removable = mayRemove(list);
    return (
        <Section
            caption={C.title}
            actions={
                <Note>
                    {C.nextChange}{" "}
                    {list.replaceableFrom === null ? (
                        C.now
                    ) : (
                        <Time at={list.replaceableFrom} format="day" />
                    )}
                </Note>
            }
        >
            <RefusalNote refused={refused} />
            <SettingRows label={C.title}>
                {list.enrollments.map((enrollment) => (
                    <Waiting
                        key={enrollment.enrollmentId}
                        enrollment={enrollment}
                        list={list}
                        onRefused={setRefused}
                    />
                ))}
                {list.devices.length === 0 && list.enrollments.length === 0 ? (
                    <SettingRow layout="item" name={C.noDevices} />
                ) : null}
                {list.devices.map((device) => (
                    <SettingRow
                        key={device.deviceId}
                        layout="item"
                        name={nameOf(device)}
                        value={
                            device.lastSeenAt === null ? (
                                C.never
                            ) : (
                                <Time at={device.lastSeenAt} format="relative" />
                            )
                        }
                        action={
                            <>
                                <Rename device={device} />
                                {removable ? <Remove device={device} /> : null}
                            </>
                        }
                    />
                ))}
            </SettingRows>
        </Section>
    );
}
