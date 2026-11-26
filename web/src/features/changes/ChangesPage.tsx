import type { Outcome } from "../../server/outcome.ts";
import { Page } from "../../ui/Page/Page.tsx";
import { productName } from "../products/view.ts";
import { CHANGES_COPY as C } from "./copy.ts";
import { Entries } from "./Entries.tsx";
import type { fetchChangelog } from "./server.ts";

type Page2 = Extract<Awaited<ReturnType<typeof fetchChangelog>>, { readonly ok: true }>["value"];

// Every entry the member may see, newest first; the gutter says what each is about (the product's
// name, "loader", or "lucent" for the service). /changes is all subjects together,
// /changes/loader the loader's alone.
export function ChangesPage({
    changes,
    filter,
    loaderOnly = false,
}: {
    readonly changes: Outcome<Page2>;
    readonly filter: { readonly subject?: "product" | "loader" | "service" };
    readonly loaderOnly?: boolean;
}) {
    const names = new Map(
        (changes.ok ? changes.value.names : []).map((n) => [n.id, productName(n.name)]),
    );
    return (
        <Page title={loaderOnly ? C.loaderTitle : C.title} width="narrow">
            <Entries
                first={changes}
                filter={filter}
                subjectOf={(entry) =>
                    loaderOnly
                        ? null
                        : entry.subject === "loader"
                          ? C.loader
                          : entry.subject === "service" || entry.productId === null
                            ? C.lucent
                            : (names.get(entry.productId) ?? entry.productId)
                }
            />
        </Page>
    );
}
