// Without zod, for the browser: the staff search box asks nothing shorter, so it never sends it.
// A single character matches too much of every kind to be worth a query per keystroke.
export const SEARCH_TEXT_MIN = 2;
