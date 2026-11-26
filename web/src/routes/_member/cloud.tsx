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
import { lastProduct } from "../../features/products/lastProduct.ts";
import { fetchProducts } from "../../features/products/server.ts";
import { LOADER_PRODUCT_ID } from "../../features/products/view.ts";
import { cloudSearch } from "../../search.ts";
import { toUnavailable } from "../../server/route-control.ts";

// /cloud is one product's cloud: the product asked for (?product=), else the one last looked at,
// else the first the member holds, else the first listed. Its listings come narrowed by ?kind=
// and ?find=; the member's own items, their listings and the staff's files for it sit beside.
export const Route = createFileRoute("/_member/cloud")({
    validateSearch: cloudSearch,
    loaderDeps: ({ search }) => search,
    loader: async ({ deps }) => {
        const [catalog, listed] = await Promise.all([fetchCloudProducts(), fetchProducts()]);
        if (!catalog.ok) return catalog;
        if (!listed.ok) return toUnavailable(listed.refused.reference ?? "");
        const products = listed.value.filter((p) => p.productId !== LOADER_PRODUCT_ID);
        const last = lastProduct();
        const pick =
            products.find((p) => p.productId === deps.product) ??
            products.find((p) => p.productId === last) ??
            products.find((p) => p.access !== null) ??
            products[0];
        if (pick === undefined) return { ok: true, view: "none" } as const;
        const productId = pick.productId;
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
        const access = pick.access !== null;
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
            pick: products.map((p) => ({
                productId: p.productId,
                name: p.name,
                held: p.access !== null,
            })),
            access,
            kind,
            find: find ?? null,
            listings,
            items,
            mine,
            files,
            canAppend: catalog.value.canAppend && canCreate,
        } as const;
    },
    head: () => ({ meta: [{ title: SITE_COPY.pageTitle(CLOUD_COPY.title) }] }),
    component: CloudPage,
});
