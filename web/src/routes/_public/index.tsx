import { createFileRoute } from "@tanstack/react-router";
import { PublicProductsPage } from "../../features/products/PublicProductsPage.tsx";
import { fetchPublicProducts } from "../../features/products/server.ts";

export const Route = createFileRoute("/_public/")({
    loader: () => fetchPublicProducts(),
    component: PublicProductsPage,
});
