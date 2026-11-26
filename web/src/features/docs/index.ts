// The docs contents, built from what is on disk: file paths, each page's `meta` and each scope's
// `sections.ts`. Pure, so what the files mean is tested without any files.

export type Section = { readonly id: string; readonly label: string };
export type Meta = { readonly title: string; readonly order: number };

export type DocPage = {
    readonly scope: string;
    readonly section: string;
    readonly page: string;
    readonly title: string;
};

export type DocSection = Section & { readonly pages: readonly DocPage[] };
export type DocScope = {
    readonly scope: string;
    readonly sections: readonly DocSection[];
    // Every page in reading order: what previous and next walk.
    readonly pages: readonly DocPage[];
};

const PATH =
    /^\/content\/docs\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)\.mdx$/;

export function parseDocPath(
    path: string,
): { readonly scope: string; readonly section: string; readonly page: string } | null {
    const found = PATH.exec(path);
    const [, scope, section, page] = found ?? [];
    return scope === undefined || section === undefined || page === undefined
        ? null
        : { scope, section, page };
}

// The scopes that have at least one page, in path order.
export function scopesWithPages(files: readonly string[]): readonly string[] {
    return [...new Set(files.flatMap((file) => parseDocPath(file)?.scope ?? []))].sort((a, b) =>
        a.localeCompare(b),
    );
}

// Sections in the order their scope's `sections.ts` lists them (one it does not list comes after,
// by id); pages in `order`, then by title. A file that is not a page path, or has no `meta`, is
// not in the contents.
export function buildScopes(params: {
    readonly files: readonly string[];
    readonly metas: Readonly<Record<string, Meta | undefined>>;
    readonly sections: Readonly<Record<string, readonly Section[] | undefined>>;
}): readonly DocScope[] {
    const found = params.files.flatMap((file) => {
        const parsed = parseDocPath(file);
        const meta = params.metas[file];
        return parsed === null || meta === undefined ? [] : [{ ...parsed, ...meta }];
    });
    return scopesWithPages(params.files).flatMap((scope) => {
        const mine = found.filter((entry) => entry.scope === scope);
        if (mine.length === 0) return [];
        const listed = params.sections[scope] ?? [];
        const ids = [
            ...listed.map((section) => section.id),
            ...[...new Set(mine.map((entry) => entry.section))]
                .filter((id) => !listed.some((section) => section.id === id))
                .sort((a, b) => a.localeCompare(b)),
        ];
        const sections = ids.flatMap((id): DocSection[] => {
            const pages = mine
                .filter((entry) => entry.section === id)
                .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
                .map(({ section, page, title }) => ({ scope, section, page, title }));
            return pages.length === 0
                ? []
                : [{ id, label: listed.find((section) => section.id === id)?.label ?? id, pages }];
        });
        return [{ scope, sections, pages: sections.flatMap((section) => section.pages) }];
    });
}

export function neighbours(
    scope: DocScope,
    at: { readonly section: string; readonly page: string },
): { readonly previous: DocPage | null; readonly next: DocPage | null } {
    const index = scope.pages.findIndex(
        (entry) => entry.section === at.section && entry.page === at.page,
    );
    if (index < 0) return { previous: null, next: null };
    return { previous: scope.pages[index - 1] ?? null, next: scope.pages[index + 1] ?? null };
}
