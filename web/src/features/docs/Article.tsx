import { Children, isValidElement, type ReactNode } from "react";
import { Code } from "../../ui/Code/Code.tsx";
import { ExternalLink } from "../../ui/ExternalLink/ExternalLink.tsx";
import styles from "./Article.module.css";

function textOf(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (isValidElement<{ readonly children?: ReactNode }>(node)) return textOf(node.props.children);
    return Children.toArray(node).map(textOf).join("");
}

export function slugOf(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

// A callout: a pink edge, the text beside it.
export function Note({ children }: { readonly children: ReactNode }) {
    return <aside className={styles.note}>{children}</aside>;
}

// The only elements an article maps: an h2 with an id (the "on this page" links point at it), a
// code block through the shared Code, and links through ExternalLink. Everything else is plain
// HTML styled by `.article` below.
export const articleComponents = {
    h2: ({ children }: { readonly children?: ReactNode }) => (
        <h2 id={slugOf(textOf(children))}>{children}</h2>
    ),
    pre: ({ children }: { readonly children?: ReactNode }) => (
        <Code>{textOf(children).trimEnd()}</Code>
    ),
    a: ({ href, children }: { readonly href?: string; readonly children?: ReactNode }) =>
        href === undefined ? (
            <span>{children}</span>
        ) : (
            <ExternalLink href={href}>{children}</ExternalLink>
        ),
    Note,
};

// What an article's elements look like, once: the page's body inside it, or the dev kit's
// hand-written specimen.
export function Article({ children }: { readonly children: ReactNode }) {
    return <div className={styles.article}>{children}</div>;
}
