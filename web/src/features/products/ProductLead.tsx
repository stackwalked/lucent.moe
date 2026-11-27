import { getRouteApi, Link } from "@tanstack/react-router";
import { ProductPick, type ProductPickRow } from "../../ui/ProductPick/ProductPick.tsx";
import { Tabs } from "../../ui/Tabs/Tabs.tsx";
import { DOCS_COPY } from "../docs/copy.ts";
import { hasDocs } from "../docs/has.ts";
import { PRODUCTS_COPY as C } from "./copy.ts";
import styles from "./ProductPage.module.css";
import { productName, statusWord } from "./view.ts";

const route = getRouteApi("/_member/products/$productId");

// What leads the head row of every page of a product: its name, which is the picker for
// switching products (staying on the same tab), then the product's tabs.
export function ProductLead({ at }: { readonly at: "changes" | "cloud" }) {
    const { product, held, status } = route.useLoaderData();
    const rows: readonly ProductPickRow[] = status.products.map((listed) => ({
        id: listed.productId,
        label: productName(listed.name),
        status: held.includes(listed.productId)
            ? statusWord(listed.state, listed.supported)
            : "no-access",
    }));
    const productId = product.productId;
    return (
        <>
            <h1 className={styles.title}>
                <ProductPick
                    label={productName(product.name)}
                    rows={rows}
                    current={productId}
                    linkFor={(id, children) =>
                        at === "cloud" ? (
                            <Link to="/products/$productId/cloud" params={{ productId: id }}>
                                {children}
                            </Link>
                        ) : (
                            <Link to="/products/$productId" params={{ productId: id }}>
                                {children}
                            </Link>
                        )
                    }
                />
            </h1>
            <Tabs
                tabs={[
                    {
                        to: "/products/$productId",
                        params: { productId },
                        label: C.changesTab,
                    },
                    ...(hasDocs(productId)
                        ? [
                              {
                                  to: "/docs/$scope" as const,
                                  params: { scope: productId },
                                  label: DOCS_COPY.title,
                              },
                          ]
                        : []),
                    {
                        to: "/products/$productId/cloud",
                        params: { productId },
                        label: C.cloudTab,
                    },
                ]}
            />
        </>
    );
}
