import { Select } from "../../ui/Select/Select.tsx";
import { productName } from "./view.ts";

type Listed = { readonly productId: string; readonly name: string };

// Choosing one of the listed products, or none. A chosen product the list doesn't hold (one
// named in the address, retired or out of reach since) stays an option under its id, so the
// form never quietly sends without it.
export function ProductSelect({
    name,
    label,
    none,
    products,
    defaultValue = "",
}: {
    readonly name: string;
    readonly label: string;
    readonly none: string;
    readonly products: readonly Listed[];
    readonly defaultValue?: string;
}) {
    const unlisted =
        defaultValue !== "" && !products.some((p) => p.productId === defaultValue)
            ? [{ value: defaultValue, label: defaultValue }]
            : [];
    return (
        <Select
            name={name}
            label={label}
            defaultValue={defaultValue}
            options={[
                { value: "", label: none },
                ...products.map((p) => ({ value: p.productId, label: productName(p.name) })),
                ...unlisted,
            ]}
        />
    );
}
