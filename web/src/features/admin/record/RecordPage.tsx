import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useActionState } from "react";
import type { Outcome, Refused } from "../../../server/outcome.ts";
import { Button } from "../../../ui/Button/Button.tsx";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Select } from "../../../ui/Select/Select.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Status } from "../../../ui/Status/Status.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { TextArea } from "../../comments/TextArea.tsx";
import { productName } from "../../products/view.ts";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { useStaffAction } from "../staff.ts";
import { RECORD_COPY as C } from "./copy.ts";
import {
    addEntry,
    addIssue,
    closeIssue,
    deleteEntry,
    deleteIssue,
    updateEntry,
    updateIssue,
} from "./server.ts";

const route = getRouteApi("/_admin/admin/record");

const ISSUE_BODY_MAX = 2_000;
const ENTRY_BODY_MAX = 4_000;

type Product = { readonly id: string; readonly name: string };
type Fields = { readonly productId: string | null; readonly title: string; readonly body: string };

function fieldsOf(form: FormData): Fields {
    const product = String(form.get("productId") ?? "");
    return {
        productId: product === "" ? null : product,
        title: String(form.get("title") ?? ""),
        body: String(form.get("body") ?? ""),
    };
}

type EntryFields = {
    readonly subject: "product" | "loader" | "service";
    readonly productId: string | null;
    readonly version: string | null;
    readonly title: string | null;
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly fixed: readonly string[];
    readonly body: string;
};

const linesOf = (form: FormData, name: string): readonly string[] =>
    String(form.get(name) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");

const blank = (form: FormData, name: string): string | null => {
    const value = String(form.get(name) ?? "").trim();
    return value === "" ? null : value;
};

// The subject select carries the product with it: "product:<id>" is that product's entries,
// "loader" the loader's, "lucent" the service's.
function entryFieldsOf(form: FormData): EntryFields {
    const about = String(form.get("subject") ?? "lucent");
    const product = about.startsWith("product:") ? about.slice("product:".length) : null;
    return {
        subject: product !== null ? "product" : about === "loader" ? "loader" : "service",
        productId: product,
        version: blank(form, "version"),
        title: blank(form, "title"),
        added: linesOf(form, "added"),
        changed: linesOf(form, "changed"),
        fixed: linesOf(form, "fixed"),
        body: String(form.get("body") ?? ""),
    };
}

function subjectOf(entry: {
    readonly subject: "product" | "loader" | "service";
    readonly productId: string | null;
}): string {
    return entry.subject === "product" && entry.productId !== null
        ? `product:${entry.productId}`
        : entry.subject;
}

function EntryFieldsInputs({
    products,
    current,
}: {
    readonly products: readonly Product[];
    readonly current: EntryFields | null;
}) {
    const list = (lines: readonly string[] | undefined) =>
        lines === undefined || lines.length === 0 ? {} : { defaultValue: lines.join("\n") };
    return (
        <>
            <Select
                name="subject"
                label={C.about}
                defaultValue={current === null ? "lucent" : subjectOf(current)}
                options={[
                    ...products.map((product) => ({
                        value: `product:${product.id}`,
                        label: productName(product.name),
                    })),
                    { value: "loader", label: C.loaderAbout },
                    { value: "lucent", label: C.service },
                ]}
            />
            <TextField
                name="version"
                label={C.version}
                maxLength={40}
                {...(current?.version == null ? {} : { defaultValue: current.version })}
            />
            <TextField
                name="title"
                label={C.titleField}
                maxLength={120}
                {...(current?.title == null ? {} : { defaultValue: current.title })}
            />
            <TextArea
                name="added"
                label={C.addedLines}
                maxLength={6200}
                {...list(current?.added)}
            />
            <TextArea
                name="changed"
                label={C.changedLines}
                maxLength={6200}
                {...list(current?.changed)}
            />
            <TextArea
                name="fixed"
                label={C.fixedLines}
                maxLength={6200}
                {...list(current?.fixed)}
            />
            <TextArea
                name="body"
                label={C.body}
                maxLength={ENTRY_BODY_MAX}
                {...(current === null || current.body === "" ? {} : { defaultValue: current.body })}
            />
        </>
    );
}

function AddEntry({
    products,
    add,
}: {
    readonly products: readonly Product[];
    readonly add: (fields: EntryFields) => Promise<Outcome<string>>;
}) {
    const router = useRouter();
    const staff = useStaffAction();
    const [answer, submit, pending] = useActionState(
        async (_: Answer, form: FormData): Promise<Answer> => {
            const added = await staff("releases:promote", () => add(entryFieldsOf(form)));
            if (!added.ok) return { refused: added.refused };
            await router.invalidate();
            return null;
        },
        null,
    );
    return (
        <Section caption={C.addEntry}>
            <form action={submit} key={answer === null ? "fresh" : "kept"}>
                <fieldset disabled={pending}>
                    <Stack gap={3}>
                        <EntryFieldsInputs products={products} current={null} />
                        <RefusalNote
                            refused={answer?.refused ?? null}
                            overrides={{ NO_PASSKEY: ADMIN_COPY.needsPasskey }}
                        />
                        <div>
                            <Button type="submit" pending={pending}>
                                {C.add}
                            </Button>
                        </div>
                    </Stack>
                </fieldset>
            </form>
        </Section>
    );
}

function NoteFields({
    products,
    current,
    bodyMax,
}: {
    readonly products: readonly Product[];
    readonly current: Fields | null;
    readonly bodyMax: number;
}) {
    return (
        <>
            <TextField
                name="title"
                label={C.titleField}
                required
                maxLength={120}
                {...(current === null ? {} : { defaultValue: current.title })}
            />
            <TextArea
                name="body"
                label={C.body}
                maxLength={bodyMax}
                {...(current === null ? {} : { defaultValue: current.body })}
            />
            <Select
                name="productId"
                label={C.product}
                defaultValue={current?.productId ?? ""}
                options={[
                    { value: "", label: C.service },
                    ...products.map((product) => ({
                        value: product.id,
                        label: productName(product.name),
                    })),
                ]}
            />
        </>
    );
}

type Answer = { readonly refused: Refused } | null;

function AddNote({
    caption,
    products,
    bodyMax,
    add,
}: {
    readonly caption: string;
    readonly products: readonly Product[];
    readonly bodyMax: number;
    readonly add: (fields: Fields) => Promise<Outcome<string>>;
}) {
    const router = useRouter();
    const staff = useStaffAction();
    const [answer, submit, pending] = useActionState(
        async (_: Answer, form: FormData): Promise<Answer> => {
            const added = await staff("releases:promote", () => add(fieldsOf(form)));
            if (!added.ok) return { refused: added.refused };
            await router.invalidate();
            return null;
        },
        null,
    );
    return (
        <Section caption={caption}>
            <form action={submit} key={answer === null ? "fresh" : "kept"}>
                <fieldset disabled={pending}>
                    <Stack gap={3}>
                        <NoteFields products={products} current={null} bodyMax={bodyMax} />
                        <RefusalNote
                            refused={answer?.refused ?? null}
                            overrides={{ NO_PASSKEY: ADMIN_COPY.needsPasskey }}
                        />
                        <div>
                            <Button type="submit" pending={pending}>
                                {C.add}
                            </Button>
                        </div>
                    </Stack>
                </fieldset>
            </form>
        </Section>
    );
}

// Known issues and changelog entries, for one product or the whole site. Writing them is
// releases:promote, behind its passkey step-up; they show publicly without a deploy.
export function RecordPage() {
    const outcome = route.useLoaderData();
    if (!outcome.ok) {
        return (
            <Page title={C.title}>
                <RefusalNote refused={outcome.refused} />
            </Page>
        );
    }
    const { issues, changelog, truncated, products } = outcome.value;
    const about = (productId: string | null) => {
        if (productId === null) return C.service;
        const product = products.find((p) => p.id === productId);
        return product === undefined ? productId : productName(product.name);
    };
    return (
        <Page title={C.title}>
            <Stack gap={6}>
                {truncated ? <p>{C.truncated}</p> : null}
                <AddNote
                    caption={C.addIssue}
                    products={products}
                    bodyMax={ISSUE_BODY_MAX}
                    add={(fields) => addIssue({ data: fields })}
                />
                <Section caption={C.issues}>
                    {issues.length === 0 ? (
                        <Empty>{C.noIssues}</Empty>
                    ) : (
                        <Table
                            caption={C.issues}
                            rows={issues}
                            rowKey={(issue) => issue.id}
                            columns={[
                                {
                                    key: "title",
                                    header: C.titleField,
                                    cell: (issue) => issue.title,
                                },
                                {
                                    key: "product",
                                    header: C.product,
                                    cell: (issue) => about(issue.productId),
                                },
                                {
                                    key: "opened",
                                    header: C.opened,
                                    cell: (issue) => <Time at={issue.openedAt} />,
                                },
                                {
                                    key: "state",
                                    header: C.state,
                                    cell: (issue) =>
                                        issue.closedAt === null ? (
                                            <Status tone="pink">{C.open}</Status>
                                        ) : (
                                            <Status>{C.closed}</Status>
                                        ),
                                },
                                {
                                    key: "actions",
                                    header: "",
                                    align: "end",
                                    cell: (issue) => (
                                        <Stack direction="row" gap={2}>
                                            <AccountAction
                                                action="releases:promote"
                                                label={C.edit}
                                                submitLabel={C.save}
                                                title={C.editTitle(issue.title)}
                                                fields={
                                                    <Stack gap={3}>
                                                        <NoteFields
                                                            products={products}
                                                            current={issue}
                                                            bodyMax={ISSUE_BODY_MAX}
                                                        />
                                                    </Stack>
                                                }
                                                run={(form) =>
                                                    updateIssue({
                                                        data: {
                                                            issueId: issue.id,
                                                            ...fieldsOf(form),
                                                        },
                                                    })
                                                }
                                            />
                                            {issue.closedAt === null ? (
                                                <AccountAction
                                                    action="releases:promote"
                                                    label={C.close}
                                                    title={C.closeTitle(issue.title)}
                                                    fields={null}
                                                    run={() =>
                                                        closeIssue({ data: { issueId: issue.id } })
                                                    }
                                                />
                                            ) : null}
                                            <AccountAction
                                                action="releases:promote"
                                                label={C.remove}
                                                title={C.removeTitle(issue.title)}
                                                tone="danger"
                                                fields={<p>{C.removeBody}</p>}
                                                run={() =>
                                                    deleteIssue({ data: { issueId: issue.id } })
                                                }
                                            />
                                        </Stack>
                                    ),
                                },
                            ]}
                        />
                    )}
                </Section>
                <AddEntry products={products} add={(fields) => addEntry({ data: fields })} />
                <Section caption={C.changelog}>
                    {changelog.length === 0 ? (
                        <Empty>{C.noEntries}</Empty>
                    ) : (
                        <Table
                            caption={C.changelog}
                            rows={changelog}
                            rowKey={(entry) => entry.id}
                            columns={[
                                {
                                    key: "title",
                                    header: C.titleField,
                                    cell: (entry) => entry.version ?? entry.title ?? "\u2014",
                                },
                                {
                                    key: "product",
                                    header: C.product,
                                    cell: (entry) =>
                                        entry.subject === "loader"
                                            ? C.loaderAbout
                                            : entry.subject === "service"
                                              ? C.service
                                              : about(entry.productId),
                                },
                                {
                                    key: "published",
                                    header: C.published,
                                    cell: (entry) => <Time at={entry.publishedAt} />,
                                },
                                {
                                    key: "actions",
                                    header: "",
                                    align: "end",
                                    cell: (entry) => (
                                        <Stack direction="row" gap={2}>
                                            <AccountAction
                                                action="releases:promote"
                                                label={C.edit}
                                                submitLabel={C.save}
                                                title={C.editTitle(
                                                    entry.title ?? entry.version ?? entry.id,
                                                )}
                                                fields={
                                                    <Stack gap={3}>
                                                        <EntryFieldsInputs
                                                            products={products}
                                                            current={entry}
                                                        />
                                                    </Stack>
                                                }
                                                run={(form) =>
                                                    updateEntry({
                                                        data: {
                                                            entryId: entry.id,
                                                            ...entryFieldsOf(form),
                                                        },
                                                    })
                                                }
                                            />
                                            <AccountAction
                                                action="releases:promote"
                                                label={C.remove}
                                                title={C.removeTitle(
                                                    entry.title ?? entry.version ?? entry.id,
                                                )}
                                                tone="danger"
                                                fields={<p>{C.removeBody}</p>}
                                                run={() =>
                                                    deleteEntry({ data: { entryId: entry.id } })
                                                }
                                            />
                                        </Stack>
                                    ),
                                },
                            ]}
                        />
                    )}
                </Section>
            </Stack>
        </Page>
    );
}
