import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useActionState } from "react";
import type { Outcome, Refused } from "../../../server/outcome.ts";
import { Button } from "../../../ui/Button/Button.tsx";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Field } from "../../../ui/Field/Field.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Refusal } from "../../../ui/Refusal/Refusal.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Select } from "../../../ui/Select/Select.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { Table } from "../../../ui/Table/Table.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { Time } from "../../../ui/Time/Time.tsx";
import { Who } from "../../../ui/Who/Who.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { TextArea } from "../../comments/TextArea.tsx";
import { productName } from "../../products/view.ts";
import { sizeText } from "../../resources/copy.ts";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { useStaffAction } from "../staff.ts";
import { STAFF_RESOURCES_COPY as C, STAFF_RESOURCES_TITLE } from "./copy.ts";
import { deleteResource, publishResource, updateResource } from "./server.ts";
import { uploadFile } from "./upload.ts";

const route = getRouteApi("/_admin/admin/resources");

const MAX_BYTES = 64 * 1024 * 1024;

type Product = { readonly id: string; readonly name: string };

type Fields = {
    readonly productId: string | null;
    readonly title: string;
    readonly description: string;
    readonly fileName: string;
};

function fieldsOf(form: FormData, fallbackName: string): Fields {
    const product = String(form.get("productId") ?? "");
    const fileName = String(form.get("fileName") ?? "").trim();
    return {
        productId: product === "" ? null : product,
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? ""),
        fileName: fileName === "" ? fallbackName : fileName,
    };
}

function ProductPicker({
    products,
    current,
}: {
    readonly products: readonly Product[];
    readonly current: string | null;
}) {
    return (
        <Select
            name="productId"
            label={C.product}
            defaultValue={current ?? ""}
            options={[
                { value: "", label: C.everyone },
                ...products.map((p) => ({ value: p.id, label: productName(p.name) })),
            ]}
        />
    );
}

function nameOf(products: readonly Product[], productId: string): string {
    const product = products.find((p) => p.id === productId);
    return product === undefined ? productId : productName(product.name);
}

function DetailFields({
    products,
    current,
}: {
    readonly products: readonly Product[];
    readonly current: Fields | null;
}) {
    return (
        <>
            <TextField
                name="title"
                label={C.title}
                required
                maxLength={120}
                {...(current === null ? {} : { defaultValue: current.title })}
            />
            <TextArea
                name="description"
                label={C.description}
                maxLength={2000}
                {...(current === null ? {} : { defaultValue: current.description })}
            />
            <TextField
                name="fileName"
                label={C.fileName}
                required={current !== null}
                maxLength={120}
                {...(current === null ? {} : { defaultValue: current.fileName })}
            />
            <ProductPicker products={products} current={current?.productId ?? null} />
        </>
    );
}

// Files staff publish for members, up to 64 MiB: uploaded, then published with what members see
// of them. Publishing, editing and removing are releases:promote, behind its passkey step-up.
export function StaffResourcesPage() {
    const outcome = route.useLoaderData();
    if (!outcome.ok) {
        return (
            <Page title={STAFF_RESOURCES_TITLE}>
                <RefusalNote refused={outcome.refused} />
            </Page>
        );
    }
    const { items, truncated, products } = outcome.value;
    return (
        <Page title={STAFF_RESOURCES_TITLE}>
            <Stack gap={6}>
                <Publish products={products} />
                <Section caption={C.list}>
                    {items.length === 0 ? (
                        <Empty>{C.none}</Empty>
                    ) : (
                        <Stack gap={2}>
                            {truncated ? <p>{C.truncated}</p> : null}
                            <Table
                                caption={C.list}
                                rows={items}
                                rowKey={(item) => item.id}
                                columns={[
                                    { key: "title", header: C.title, cell: (item) => item.title },
                                    {
                                        key: "product",
                                        header: C.product,
                                        cell: (item) =>
                                            item.productId === null
                                                ? C.everyone
                                                : nameOf(products, item.productId),
                                    },
                                    {
                                        key: "size",
                                        header: C.size,
                                        cell: (item) => sizeText(item.size),
                                    },
                                    {
                                        key: "published",
                                        header: C.published,
                                        cell: (item) => <Time at={item.publishedAt} />,
                                    },
                                    {
                                        key: "by",
                                        header: C.by,
                                        cell: (item) => (
                                            <Who
                                                accountId={item.publishedBy.id}
                                                username={item.publishedBy.username}
                                                pending={ADMIN_COPY.pending}
                                            />
                                        ),
                                    },
                                    {
                                        key: "actions",
                                        header: "",
                                        align: "end",
                                        cell: (item) => (
                                            <Stack direction="row" gap={2}>
                                                <AccountAction
                                                    action="releases:promote"
                                                    label={C.edit}
                                                    submitLabel={C.save}
                                                    title={C.editTitle(item.title)}
                                                    fields={
                                                        <Stack gap={3}>
                                                            <DetailFields
                                                                products={products}
                                                                current={item}
                                                            />
                                                        </Stack>
                                                    }
                                                    run={(form) =>
                                                        updateResource({
                                                            data: {
                                                                resourceId: item.id,
                                                                ...fieldsOf(form, item.fileName),
                                                            },
                                                        })
                                                    }
                                                />
                                                <AccountAction
                                                    action="releases:promote"
                                                    label={C.remove}
                                                    title={C.removeTitle(item.title)}
                                                    tone="danger"
                                                    fields={<p>{C.removeBody}</p>}
                                                    run={() =>
                                                        deleteResource({
                                                            data: { resourceId: item.id },
                                                        })
                                                    }
                                                />
                                            </Stack>
                                        ),
                                    },
                                ]}
                            />
                        </Stack>
                    )}
                </Section>
            </Stack>
        </Page>
    );
}

type Answer = { readonly refused: Refused } | { readonly problem: string } | null;

function Publish({ products }: { readonly products: readonly Product[] }) {
    const router = useRouter();
    const staff = useStaffAction();
    const [answer, submit, pending] = useActionState(
        async (_: Answer, form: FormData): Promise<Answer> => {
            const file = form.get("file");
            if (!(file instanceof File) || file.size === 0) return { problem: C.noFile };
            if (file.size > MAX_BYTES) return { problem: C.tooLarge };
            const published = await staff(
                "releases:promote",
                async (): Promise<Outcome<string>> => {
                    const stored = await uploadFile(file);
                    if (!stored.ok) return stored;
                    return await publishResource({
                        data: { digest: stored.value.digest, ...fieldsOf(form, file.name) },
                    });
                },
            );
            if (!published.ok) return { refused: published.refused };
            await router.invalidate();
            return null;
        },
        null,
    );
    return (
        <Section caption={C.publish}>
            <form action={submit} key={answer === null ? "fresh" : "kept"}>
                <fieldset disabled={pending}>
                    <Stack gap={3}>
                        <Field label={C.file} hint={C.fileHint}>
                            {(control) => <input {...control} type="file" name="file" required />}
                        </Field>
                        <DetailFields products={products} current={null} />
                        {answer !== null && "problem" in answer ? (
                            <Refusal>{answer.problem}</Refusal>
                        ) : null}
                        <RefusalNote
                            refused={answer !== null && "refused" in answer ? answer.refused : null}
                            overrides={{ NO_PASSKEY: ADMIN_COPY.needsPasskey }}
                        />
                        <div>
                            <Button type="submit" pending={pending}>
                                {C.send}
                            </Button>
                        </div>
                    </Stack>
                </fieldset>
            </form>
        </Section>
    );
}
