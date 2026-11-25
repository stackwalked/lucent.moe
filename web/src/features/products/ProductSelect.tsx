import { Select } from "../../ui/Select/Select.tsx";
import { productName } from "./view.ts";

// Choosing one of the products the member can see (fetchProducts), or none.
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
    readonly products: readonly { readonly productId: string; readonly name: string }[];
    readonly defaultValue?: string;
}) {
    return (
        <Select
            name={name}
            label={label}
            defaultValue={defaultValue}
            options={[
                { value: "", label: none },
                ...products.map((p) => ({ value: p.productId, label: productName(p.name) })),
            ]}
        />
    );
}
