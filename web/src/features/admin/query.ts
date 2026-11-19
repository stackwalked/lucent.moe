// An admin list's one parameter, ?q=: `key:value` tokens beside free text, e.g.
// "status:suspended role:role_mod ali". Each list names the keys it knows; anything else,
// unknown keys included, is search text. A known key given twice, or with no value, filters
// nothing and is said back as ignored, so the list never looks filtered when it isn't.
export type ParsedQuery<K extends string> = {
    readonly tokens: Readonly<Partial<Record<K, string>>>;
    readonly text: string | null;
    readonly ignored: readonly string[];
};

export function parseQuery<K extends string>(
    q: string | undefined,
    keys: readonly K[],
): ParsedQuery<K> {
    const tokens: Partial<Record<K, string>> = {};
    const words: string[] = [];
    const ignored: string[] = [];
    for (const word of (q ?? "")
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0)) {
        const colon = word.indexOf(":");
        const key = keys.find((k) => k === word.slice(0, colon));
        const value = word.slice(colon + 1);
        if (colon <= 0 || key === undefined) words.push(word);
        else if (value.length > 0 && tokens[key] === undefined) tokens[key] = value;
        else ignored.push(word);
    }
    return { tokens, text: words.length === 0 ? null : words.join(" "), ignored };
}
