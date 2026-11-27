import { createFileRoute } from "@tanstack/react-router";
import { SITE_COPY } from "../../copy/site.ts";
import { CloudPage } from "../../features/cloud/CloudPage.tsx";
import { CLOUD_COPY } from "../../features/cloud/copy.ts";
import {
    fetchCloudProducts,
    fetchHistory,
    fetchItems,
    fetchListings,
    fetchMine,
    fetchStaffFiles,
} from "../../features/cloud/server.ts";
import { cloudSearch } from "../../search.ts";

// One product's cloud: its listings, narrowed by ?kind= and ?find=; the member's own items, their
// listings and the staff's files for it sit beside. ?item= is one item's history instead.
export const Route = createFileRoute("/_member/products/$productId/cloud")({
    validateSearch: cloudSearch,
    loaderDeps: ({ search }) => search,
    loader: async ({ deps, params, parentMatchPromise }) => {
        const { product } = (await parentMatchPromise).loaderData ?? {};
        const catalog = await fetchCloudProducts();
        if (!catalog.ok) return catalog;
        const productId = params.productId;
        const cloud = catalog.value.products.find((p) => p.id === productId);
        const canCreate = cloud?.canCreate === true;
        if (deps.item) {
            const history = await fetchHistory({ data: { productId, itemId: deps.item } });
            if (!history.ok) return history;
            return {
                ok: true,
                view: "history",
                productId,
                itemId: deps.item,
                history: history.value,
                canAppend: catalog.value.canAppend && canCreate,
                canShare: canCreate,
            } as const;
        }
        const access = product !== undefined && product.access !== null;
        const kind = deps.kind;
        const find = deps.find === undefined || deps.find === "" ? undefined : deps.find;
        const [listings, items, mine, files] = access
            ? await Promise.all([
                  fetchListings({
                      data: {
                          productId,
                          ...(kind === undefined ? {} : { kind }),
                          ...(find === undefined ? {} : { text: find }),
                      },
                  }),
                  fetchItems({ data: { productId } }),
                  fetchMine({ data: { productId } }),
                  fetchStaffFiles(),
              ])
            : [null, null, null, null];
        return {
            ok: true,
            view: "items",
            productId,
            access,
            kind,
            find: find ?? null,
            listings,
            items,
            mine,
            files,
        } as const;
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(CLOUD_COPY.title) }] }),
    component: CloudPage,
});
