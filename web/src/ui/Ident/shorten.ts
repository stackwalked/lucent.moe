const HEAD = 8;
const TAIL = 4;

// The middle goes, so the type prefix and the end (what people compare ids by) stay. An id that
// would not get shorter is left whole.
export function shortenIdent(value: string): string {
    if (value.length <= HEAD + TAIL + 1) return value;
    return `${value.slice(0, HEAD)}…${value.slice(-TAIL)}`;
}
