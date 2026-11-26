import { getRouteApi, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { HeadRow } from "../../ui/HeadRow/HeadRow.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { ProductPick } from "../../ui/ProductPick/ProductPick.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { productName } from "../products/view.ts";
import styles from "./Article.module.css";
import { Article, articleComponents } from "./Article.tsx";
import { DOCS } from "./content.ts";
import { DOCS_COPY as C } from "./copy.ts";
import layout from "./DocsPage.module.css";
import { DOC_LOADERS } from "./files.ts";
import { neighbours } from "./index.ts";

const route = getRouteApi("/_member/docs/$scope/$section/$page");

type Heading = { readonly id: string; readonly text: string };

// The article's h2s as they render: the body loads lazily, so the list follows the DOM.
function useHeadings(page: string) {
    const article = useRef<HTMLElement>(null);
    const [headings, setHeadings] = useState<readonly Heading[]>([]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new page is a new body to read
    useEffect(() => {
        const element = article.current;
        if (element === null) return;
        const read = () =>
            setHeadings(
                [...element.querySelectorAll("h2[id]")].map((h2) => ({
                    id: h2.id,
                    text: h2.textContent ?? "",
                })),
            );
        read();
        const watch = new MutationObserver(read);
        watch.observe(element, { childList: true, subtree: true });
        return () => watch.disconnect();
    }, [page]);
    return { article, headings };
}

// The one page with three columns: contents (the product picker on top), the article, and "on
// this page". The contents' head row and the "on this page" caption are the first hairlines, level
// 80px under the bar. Where there is no room the right column goes, then the contents fold into a
// <details> above the article.
export function DocsPage() {
    const { scopes, scope, section, page } = route.useLoaderData();
    const current = DOCS.find((entry) => entry.scope === scope);
    const loader = DOC_LOADERS[`/content/docs/${scope}/${section}/${page}.mdx`];
    const Content = useMemo(() => (loader === undefined ? null : lazy(loader)), [loader]);
    const { article, headings } = useHeadings(`${scope}/${section}/${page}`);
    if (current === undefined || Content === null) return null;
    const entry = current.sections
        .flatMap((s) => s.pages)
        .find((p) => p.section === section && p.page === page);
    const label = (id: string) =>
        id === "lucent" ? C.lucent : productName(scopes.find((s) => s.scope === id)?.name ?? id);
    const sectionLabel = current.sections.find((s) => s.id === section)?.label ?? section;
    const { previous, next } = neighbours(current, { section, page });
    const contents = (
        <nav aria-label={C.contents} className={layout.contents}>
            {current.sections.map((s) => (
                <div key={s.id} className={layout.group}>
                    <p className={layout.caption}>{s.label}</p>
                    {s.pages.map((p) => (
                        <Link
                            key={p.page}
                            to="/docs/$scope/$section/$page"
                            params={{ scope, section: p.section, page: p.page }}
                            className={layout.link}
                            {...(p.section === section && p.page === page
                                ? { "aria-current": "page" as const }
                                : {})}
                        >
                            {p.title}
                        </Link>
                    ))}
                </div>
            ))}
        </nav>
    );
    const pick = (
        <ProductPick
            label={label(scope)}
            current={scope}
            rows={scopes.map((s) => ({ id: s.scope, label: label(s.scope), status: null }))}
            linkFor={(id, children) => (
                <Link to="/docs/$scope" params={{ scope: id }}>
                    {children}
                </Link>
            )}
        />
    );
    return (
        <Page title={C.title} hideTitle tabs={null}>
            <div className={layout.grid}>
                <div className={layout.side}>
                    <div className={layout.wide}>
                        <HeadRow lead={pick} />
                        {contents}
                    </div>
                    <details className={layout.narrow}>
                        <summary>
                            {label(scope)} · {C.contents}
                        </summary>
                        {pick}
                        {contents}
                    </details>
                </div>
                <div className={layout.main}>
                    <p className={layout.crumb}>
                        {label(scope)} · {sectionLabel}
                    </p>
                    <article ref={article}>
                        <Article>
                            <h1>{entry?.title ?? page}</h1>
                            <Suspense fallback={null}>
                                <Content components={articleComponents} />
                            </Suspense>
                            <nav className={styles.links}>
                                {previous === null ? (
                                    <span />
                                ) : (
                                    <Link
                                        to="/docs/$scope/$section/$page"
                                        params={{
                                            scope,
                                            section: previous.section,
                                            page: previous.page,
                                        }}
                                    >
                                        {C.previous}
                                        <b>{previous.title}</b>
                                    </Link>
                                )}
                                {next === null ? null : (
                                    <Link
                                        to="/docs/$scope/$section/$page"
                                        params={{ scope, section: next.section, page: next.page }}
                                    >
                                        {C.next}
                                        <b>{next.title}</b>
                                    </Link>
                                )}
                            </nav>
                        </Article>
                    </article>
                </div>
                {headings.length === 0 ? (
                    <div className={layout.toc} />
                ) : (
                    <nav className={layout.toc} aria-label={C.onThisPage}>
                        <Section caption={C.onThisPage}>
                            {headings.map((heading) => (
                                <Link
                                    key={heading.id}
                                    to="/docs/$scope/$section/$page"
                                    params={{ scope, section, page }}
                                    hash={heading.id}
                                    className={layout.link}
                                >
                                    {heading.text}
                                </Link>
                            ))}
                        </Section>
                    </nav>
                )}
            </div>
        </Page>
    );
}
