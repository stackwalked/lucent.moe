import { can } from "@lucent/policy/policy";
import { getRouteApi, Link, useRouteContext } from "@tanstack/react-router";
import { Page } from "../../ui/Page/Page.tsx";
import { memberOf, subjectOf } from "../../viewer.ts";
import { productName } from "../products/view.ts";
import { SHOUTS_COPY } from "./copy.ts";
import { ShoutFeed } from "./ShoutFeed.tsx";
import { SHOUTS_TITLE } from "./title.ts";

const route = getRouteApi("/_member/shouts");

// The shout feed on a page of its own, until home carries it.
export function ShoutsPage() {
    const { shouts, products } = route.useLoaderData();
    const { product } = route.useSearch();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const canPurge = viewer !== null && can(subjectOf(viewer), "moderation:remove");
    const named = products.ok ? products.value.find((p) => p.productId === product) : undefined;
    return (
        <Page
            title={
                product === undefined
                    ? SHOUTS_TITLE
                    : SHOUTS_COPY.forProduct(
                          named === undefined ? product : productName(named.name),
                      )
            }
            actions={
                product === undefined ? null : <Link to="/shouts">{SHOUTS_COPY.allShouts}</Link>
            }
        >
            <ShoutFeed
                key={product ?? ""}
                first={shouts}
                productId={product ?? null}
                canPurge={canPurge}
            />
        </Page>
    );
}
