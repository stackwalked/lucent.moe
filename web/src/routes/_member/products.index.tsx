import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { PRODUCTS_COPY } from "../../features/products/copy.ts";
import { ProductsPage } from "../../features/products/ProductsPage.tsx";
import { fetchProducts } from "../../features/products/server.ts";

export const Route = createFileRoute("/_member/products/")({
    loader: () => fetchProducts(),
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(PRODUCTS_COPY.title) }] }),
    component: ProductsPage,
});
