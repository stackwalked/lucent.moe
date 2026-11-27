import type { EpochMs } from "@lucent/core/scalars";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useActionState, useState } from "react";
import type { Outcome, Refused } from "../../../server/outcome.ts";
import { Button } from "../../../ui/Button/Button.tsx";
import { Columns } from "../../../ui/Columns/Columns.tsx";
import { Empty } from "../../../ui/Empty/Empty.tsx";
import { Page } from "../../../ui/Page/Page.tsx";
import { Section } from "../../../ui/Section/Section.tsx";
import { Select } from "../../../ui/Select/Select.tsx";
import { Stack } from "../../../ui/Stack/Stack.tsx";
import { TextField } from "../../../ui/TextField/TextField.tsx";
import { formatAbsolute } from "../../../ui/Time/format.ts";
import { Time } from "../../../ui/Time/Time.tsx";
import { useTimeContext } from "../../../ui/Time/TimeProvider.tsx";
import { Rows } from "../../account/Rows.tsx";
import { RefusalNote } from "../../auth/RefusalNote.tsx";
import { TextArea } from "../../comments/TextArea.tsx";
import { productName } from "../../products/view.ts";
import { AccountAction } from "../accounts/AccountAction.tsx";
import { ADMIN_COPY } from "../copy.ts";
import { useStaffAction } from "../staff.ts";
import styles from "./ChangelogPage.module.css";
import { CHANGELOG_COPY as C } from "./copy.ts";
import { addEntry, deleteEntry, updateEntry } from "./server.ts";

const route = getRouteApi("/_admin/admin/products/changelog");

const ENTRY_BODY_MAX = 4_000;
const LOADER_PRODUCT_ID = "lucent-loader";

type Product = { readonly id: string; readonly name: string };
type Release = {
    readonly id: string;
    readonly productId: string;
    readonly channel: string;
    readonly number: string;
    readonly stagedAt: EpochMs;
    readonly entryId: string | null;
};
type Answer = { readonly refused: Refused } | null;

type EntryFields = {
    readonly subject: "product" | "loader" | "service";
    readonly productId: string | null;
    readonly version: string | null;
    readonly title: string | null;
    readonly added: readonly string[];
    readonly changed: readonly string[];
    readonly fixed: readonly string[];
    readonly body: string;
    readonly releaseId: string | null;
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
        releaseId: blank(form, "release"),
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

// The releases an entry about this subject can name: the subject's own, and no other entry's.
// The server's rule refuses the rest; the form only keeps from offering them.
function choosable(releases: readonly Release[], about: string, entryId: string | null) {
    return releases.filter(
        (release) =>
            (release.entryId === null || release.entryId === entryId) &&
            (about === "loader"
                ? release.productId === LOADER_PRODUCT_ID
                : about === `product:${release.productId}`),
    );
}

function EntryFieldsInputs({
    products,
    releases,
    entryId,
    current,
}: {
    readonly products: readonly Product[];
    readonly releases: readonly Release[];
    readonly entryId: string | null;
    readonly current:
        | (Omit<EntryFields, "releaseId"> & { readonly releaseId?: string | null })
        | null;
}) {
    const { timeZone } = useTimeContext();
    const [about, setAbout] = useState(current === null ? "lucent" : subjectOf(current));
    const [chosen, setChosen] = useState(current?.releaseId ?? "");
    const offered = choosable(releases, about, entryId);
    const release = offered.some((each) => each.id === chosen) ? chosen : "";
    const list = (lines: readonly string[] | undefined) =>
        lines === undefined || lines.length === 0 ? {} : { defaultValue: lines.join("\n") };
    return (
        <div className={styles.fields}>
            <div className={styles.trio}>
                <Select
                    name="subject"
                    label={C.about}
                    value={about}
                    onChange={setAbout}
                    options={[
                        ...products.map((product) => ({
                            value: `product:${product.id}`,
                            label: productName(product.name),
                        })),
                        { value: "loader", label: C.loaderAbout },
                        { value: "lucent", label: C.service },
                    ]}
                />
                <Select
                    name="release"
                    label={C.release}
                    value={release}
                    onChange={setChosen}
                    options={[
                        { value: "", label: C.none },
                        ...offered.map((each) => ({
                            value: each.id,
                            label: `${each.channel} ${each.number}, ${formatAbsolute(each.stagedAt, timeZone)}`,
                        })),
                    ]}
                />
                <TextField
                    name="version"
                    label={C.version}
                    maxLength={40}
                    required={release !== ""}
                    {...(current?.version == null ? {} : { defaultValue: current.version })}
                />
            </div>
            <TextField
                name="title"
                label={C.titleField}
                maxLength={120}
                {...(current?.title == null ? {} : { defaultValue: current.title })}
            />
            <TextArea
                name="added"
                label={C.addedLines}
                size="grow"
                maxLength={6200}
                {...list(current?.added)}
            />
            <TextArea
                name="changed"
                label={C.changedLines}
                size="grow"
                maxLength={6200}
                {...list(current?.changed)}
            />
            <TextArea
                name="fixed"
                label={C.fixedLines}
                size="grow"
                maxLength={6200}
                {...list(current?.fixed)}
            />
            <TextArea
                name="body"
                label={C.body}
                size="grow"
                maxLength={ENTRY_BODY_MAX}
                {...(current === null || current.body === "" ? {} : { defaultValue: current.body })}
            />
        </div>
    );
}

function AddEntry({
    products,
    releases,
    add,
}: {
    readonly products: readonly Product[];
    readonly releases: readonly Release[];
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
            <form action={submit} key={answer === null ? "fresh" : "kept"} className={styles.form}>
                <fieldset disabled={pending}>
                    <Stack gap={3}>
                        <EntryFieldsInputs
                            products={products}
                            releases={releases}
                            entryId={null}
                            current={null}
                        />
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

// Changelog entries, for one product, the loader or the whole site: the form to write one on the
// left, the entries so far on the right. Writing them is releases:promote, behind its passkey
// step-up; they show publicly without a deploy.
export function ChangelogPage() {
    const outcome = route.useLoaderData();
    if (!outcome.ok) {
        return (
            <Page title={C.title}>
                <RefusalNote refused={outcome.refused} />
            </Page>
        );
    }
    const { changelog, truncated, products, releases } = outcome.value;
    const about = (entry: (typeof changelog)[number]) => {
        if (entry.subject === "loader") return C.loaderAbout;
        if (entry.subject === "service" || entry.productId === null) return C.service;
        const { productId } = entry;
        const product = products.find((p) => p.id === productId);
        return product === undefined ? productId : productName(product.name);
    };
    return (
        <Page title={C.title}>
            <Columns
                main={
                    <AddEntry
                        products={products}
                        releases={releases}
                        add={(fields) => addEntry({ data: fields })}
                    />
                }
                aside={
                    <Section caption={C.changelog}>
                        {changelog.length === 0 ? (
                            <Empty>{C.noEntries}</Empty>
                        ) : (
                            <Rows
                                label={C.changelog}
                                items={changelog.map((entry) => {
                                    const name = entry.title ?? entry.version ?? entry.id;
                                    return {
                                        key: entry.id,
                                        main: entry.version ?? entry.title ?? "—",
                                        meta: (
                                            <>
                                                {about(entry)}{" "}
                                                <Time at={entry.publishedAt} format="day" />
                                            </>
                                        ),
                                        action: (
                                            <>
                                                <AccountAction
                                                    action="releases:promote"
                                                    label={C.edit}
                                                    submitLabel={C.save}
                                                    title={C.editTitle(name)}
                                                    fields={
                                                        <EntryFieldsInputs
                                                            products={products}
                                                            releases={releases}
                                                            entryId={entry.id}
                                                            current={entry}
                                                        />
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
                                                    title={C.removeTitle(name)}
                                                    tone="danger"
                                                    fields={<p>{C.removeBody}</p>}
                                                    run={() =>
                                                        deleteEntry({ data: { entryId: entry.id } })
                                                    }
                                                />
                                            </>
                                        ),
                                    };
                                })}
                            />
                        )}
                        {truncated ? <p>{C.truncated}</p> : null}
                    </Section>
                }
            />
        </Page>
    );
}
