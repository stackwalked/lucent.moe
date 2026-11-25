import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Empty } from "../../ui/Empty/Empty.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Refusal } from "../../ui/Refusal/Refusal.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { Switch } from "../../ui/Switch/Switch.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { productName } from "../products/view.ts";
import styles from "./ApplyPage.module.css";
import { WAITLIST_COPY } from "./copy.ts";
import { submitApplication } from "./server.ts";

const route = getRouteApi("/_public/apply");

const PRODUCT = "product:";

function optional(form: FormData, name: string): string | null {
    const value = String(form.get(name) ?? "").trim();
    return value === "" ? null : value;
}

// The waitlist's form. Whatever the address, the answer reads the same: it never says whether
// someone already has an account or an application.
export function ApplyPage() {
    const offered = route.useLoaderData();
    const [sent, setSent] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [refused, setRefused] = useState<Refused | null>(null);
    const products = offered.ok ? offered.value : [];

    const submit = async (form: FormData) => {
        const chosen = [...form.keys()]
            .filter((key) => key.startsWith(PRODUCT))
            .map((key) => key.slice(PRODUCT.length));
        if (chosen.length === 0) {
            setProblem(WAITLIST_COPY.pickOne);
            return;
        }
        setProblem(null);
        const reply = await submitApplication({
            data: {
                email: String(form.get("email") ?? "").trim(),
                products: chosen,
                about: String(form.get("about") ?? "").trim(),
                discord: optional(form, "discord"),
                knownBy: optional(form, "knownBy"),
            },
        });
        if (!reply.ok) {
            setRefused(reply.refused);
            return;
        }
        setRefused(null);
        setSent(true);
    };

    return (
        <Page title={WAITLIST_COPY.title} width="narrow">
            <Stack gap={4}>
                {sent ? (
                    <p role="status">{WAITLIST_COPY.sent}</p>
                ) : products.length === 0 ? (
                    <Empty>{WAITLIST_COPY.closed}</Empty>
                ) : (
                    <form action={submit}>
                        <Stack gap={4}>
                            <TextField
                                name="email"
                                label={WAITLIST_COPY.email}
                                type="email"
                                required
                                maxLength={254}
                                autoComplete="email"
                            />
                            <fieldset className={styles.products}>
                                <legend className={styles.legend}>{WAITLIST_COPY.products}</legend>
                                <Stack gap={2}>
                                    {products.map((product) => (
                                        <Switch
                                            key={product.productId}
                                            name={`${PRODUCT}${product.productId}`}
                                            label={productName(product.name)}
                                            defaultChecked={products.length === 1}
                                        />
                                    ))}
                                </Stack>
                            </fieldset>
                            <TextArea
                                name="about"
                                label={WAITLIST_COPY.about}
                                maxLength={2000}
                                required
                            />
                            <TextField
                                name="discord"
                                label={WAITLIST_COPY.discord}
                                maxLength={64}
                                autoComplete="off"
                            />
                            <TextField
                                name="knownBy"
                                label={WAITLIST_COPY.knownBy}
                                maxLength={64}
                                autoComplete="off"
                            />
                            {problem === null ? null : <Refusal>{problem}</Refusal>}
                            <RefusalNote refused={refused} />
                            <div>
                                <Button type="submit">{WAITLIST_COPY.submit}</Button>
                            </div>
                        </Stack>
                    </form>
                )}
            </Stack>
        </Page>
    );
}
