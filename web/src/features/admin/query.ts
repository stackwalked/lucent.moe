// An admin list's one parameter, ?q=: `key:value` tokens beside free text, e.g.
// "status:suspended role:role_mod ali". Each list names the keys it knows; anything else,
// unknown keys included, is search text.
export type ParsedQuery<K extends string> = {
    readonly tokens: Readonly<Partial<Record<K, string>>>;
    readonly text: string | null;
};

export function parseQuery<K extends string>(
    q: string | undefined,
    keys: readonly K[],
): ParsedQuery<K> {
    const tokens: Partial<Record<K, string>> = {};
    const words: string[] = [];
    for (const word of (q ?? "")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0)) {
        const colon = word.indexOf(":");
        const key = keys.find((k) => k === word.slice(0, colon));
        const value = word.slice(colon + 1);
        if (colon > 0 && key !== undefined && value.length > 0 && tokens[key] === undefined) {
            tokens[key] = value;
        } else {
            words.push(word);
        }
    }
    return { tokens, text: words.length === 0 ? null : words.join(" ") };
}

// The parsed form written back, tokens first in the order the list names them.
export function formatQuery<K extends string>(query: ParsedQuery<K>, keys: readonly K[]): string {
    const parts = keys.flatMap((key) => {
        const value = query.tokens[key];
        return value === undefined ? [] : [`${key}:${value}`];
    });
    return [...parts, ...(query.text === null ? [] : [query.text])].join(" ");
}
