import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { CloudPage } from "../../features/cloud/CloudPage.tsx";
import { CLOUD_COPY } from "../../features/cloud/copy.ts";
import { fetchCloudProducts, fetchHistory, fetchItems } from "../../features/cloud/server.ts";
import { cloudSearch } from "../../search.ts";

export const Route = createFileRoute("/_member/cloud")({
    validateSearch: cloudSearch,
    loaderDeps: ({ search }) => search,
    loader: async ({ deps }) => {
        const catalog = await fetchCloudProducts();
        if (!catalog.ok) return catalog;
        if (!deps.product) return { ok: true, view: "products", catalog: catalog.value } as const;
        const productId = deps.product;
        if (deps.item) {
            const history = await fetchHistory({ data: { productId, itemId: deps.item } });
            if (!history.ok) return history;
            return {
                ok: true,
                view: "history",
                productId,
                itemId: deps.item,
                history: history.value,
                canAppend: catalog.value.canAppend,
            } as const;
        }
        const items = await fetchItems({ data: { productId } });
        if (!items.ok) return items;
        return {
            ok: true,
            view: "items",
            productId,
            items: items.value,
            canAppend: catalog.value.canAppend,
        } as const;
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(CLOUD_COPY.title) }] }),
    component: CloudPage,
});
