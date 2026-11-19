# Web

Checkable rules live in `/.biome.jsonc`, `tools/lint/ast-grep/rules/web-*.yml` and `dev/css-lint.ts`.
This file holds only what no tool checks. The repo's `AGENTS.md` and `platform/AGENTS.md` apply here
too.

## Copy

- Minimal. Say what happened, then what to do; nothing else. No filler, no reassurance, no "Oops",
  no exclamation marks, no error codes in messages.
- Plain, short, second person, and all lowercase: headings, buttons, labels, page titles,
  messages, the names of browsers, systems and months too. Only what someone typed keeps its case
  (usernames, passkey names, ids, keys). Buttons are verbs ("sign in", "suspend").
- Words live in each feature's `copy.ts` (UI-kit words in `src/ui/copy.ts`); a component holds no
  sentence longer than a button label.
- Unexpected failures end with "reference: <request id>"; expected refusals don't.

Glossary:

- "account", never "person", "people" or "user", in anything a reader sees;
- "sign in" (verb), "sign-in" (noun), never "log in";
- "passkey"; "authenticator app" and "code", never TOTP;
- "setup link";
- "staff", not admins;
- "suspend" and "reinstate";
- sessions are "where you're signed in".

## UI

- Building blocks live in `src/ui/<Name>/<Name>.tsx` with `<Name>.module.css`; feature code in
  `src/features/<area>/`. Module CSS sits in `@layer components` (building blocks) or
  `@layer features`.
- Colors and sizes come from tokens (`src/ui/tokens.ts`). The contrast test covers only the
  pairings listed there: keep text and marks to those (no ink-2 on sunken, marks in pink-ink or
  shu-ink, ink-3 for inert controls only).
- Two hues: pink (yours, current, needs you) and shu (stopped, danger, refused). Success is ink
  with a check.
- Hidden, not disabled, when `can()` says no.
- Native elements first: `<dialog>` with `showModal()`, the `popover` attribute, anchor
  positioning, `<details>`; no positioning or focus-trap code.
- Every control reachable and usable by keyboard, with a visible focus ring; targets at least
  24px; every input labelled.
