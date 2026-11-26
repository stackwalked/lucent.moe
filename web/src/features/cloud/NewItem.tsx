import { newOperationId } from "@lucent/core/brands";
import { systemCryptoRng } from "@lucent/core/rng";
import { ITEM_KINDS, isItemKind } from "@lucent/rpc/cloud-item-guards";
import { useRouter } from "@tanstack/react-router";
import { useActionState, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Select } from "../../ui/Select/Select.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { CLOUD_COPY as C } from "./copy.ts";
import { createEmptyItem } from "./server.ts";

export function NewItem({ productId }: { readonly productId: string }) {
    const router = useRouter();
    const [operationId] = useState(() => newOperationId(systemCryptoRng));
    const [refused, submit, pending] = useActionState(async (_: Refused | null, form: FormData) => {
        const kind = form.get("kind");
        const name = String(form.get("name") ?? "").trim();
        if (!isItemKind(kind) || !name) return null;
        const reply = await createEmptyItem({
            data: { productId, operationId, kind, name },
        });
        if (!reply.ok) return reply.refused;
        await router.navigate({
            to: "/cloud",
            search: { product: productId, item: reply.value.itemId },
        });
        return null;
    }, null);
    return (
        <Section caption={C.create}>
            <form action={submit}>
                <Stack gap={2}>
                    <TextField name="name" label={C.name} required maxLength={64} />
                    <Select
                        name="kind"
                        label={C.kind}
                        options={ITEM_KINDS.map((kind) => ({ value: kind, label: kind }))}
                    />
                    <RefusalNote refused={refused} />
                    <Button type="submit" pending={pending}>
                        {C.create}
                    </Button>
                </Stack>
            </form>
        </Section>
    );
}
