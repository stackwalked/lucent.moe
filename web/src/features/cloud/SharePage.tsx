import { getRouteApi, Link } from "@tanstack/react-router";
import { useActionState, useEffect, useState } from "react";
import { Button } from "../../ui/Button/Button.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { CLOUD_COPY as C } from "./copy.ts";
import { consumeShareFragment } from "./link.ts";
import { importShare } from "./server.ts";

const route = getRouteApi("/_public/share");

export function SharePage() {
    const catalog = route.useLoaderData();
    const [link, setLink] = useState<ReturnType<typeof consumeShareFragment>>(null);
    useEffect(() => {
        const consume = () => {
            if (!window.location.hash) return;
            setLink(
                consumeShareFragment(new URL(window.location.href), (path) =>
                    window.history.replaceState(window.history.state, "", path),
                ),
            );
        };
        consume();
        window.addEventListener("hashchange", consume);
        return () => window.removeEventListener("hashchange", consume);
    }, []);
    const [result, submit, pending] = useActionState(async () => {
        if (!link) return null;
        const reply = await importShare({ data: link });
        if (reply.ok) setLink(null);
        return reply;
    }, null);
    const allowed =
        catalog?.ok && catalog.value.products.find((p) => p.id === link?.productId && p.canCreate);
    return (
        <Page title={C.import} width="narrow">
            {result?.ok && !link ? (
                <Link to="/cloud">{C.imported}</Link>
            ) : catalog === null ? (
                <Link to="/sign-in">{C.signIn}</Link>
            ) : !catalog.ok ? (
                <RefusalNote refused={catalog.refused} />
            ) : !allowed ? (
                <p>{C.missing}</p>
            ) : !catalog.value.canAppend ? (
                <p>{C.paused}</p>
            ) : (
                <form action={submit}>
                    <p>{allowed.name}</p>
                    <Button type="submit" pending={pending}>
                        {C.import}
                    </Button>
                    <RefusalNote refused={result && !result.ok ? result.refused : null} />
                </form>
            )}
        </Page>
    );
}
