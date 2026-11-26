-- What staff tell the public about a product, or about the service when `product_id` is null:
-- known issues and changelog entries (record/notes.ts). Plain text, bounded here as in the
-- contract. Who wrote each change is in the audit, so no row names an account. A row for a
-- product the public home does not list is never read publicly.

-- Plain text as the contract has it (rpc/web/record.ts): no control character (Cc) but a body's
-- line breaks and tabs, and no format character (Cf: bidi overrides, zero widths, tags). The Cf
-- ranges are Unicode 15.1's, written out since PostgreSQL's regex has no property classes.
create function record_plain_text(value text, multiline boolean) returns boolean
language sql immutable as $$
    select value !~ (case when multiline then '[\u0001-\u0008\u000b\u000c\u000e-\u001f]'
                          else '[\u0001-\u001f]' end)
       and value !~ ('[\u007f-\u009f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2'
                     || '\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff'
                     || '\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f'
                     || '\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001'
                     || '\U000e0020-\U000e007f]')
$$;
-- Product-scoped, or global (null product): a problem staff know of. Open until closed; a closed
-- one stays for staff and is no longer shown publicly.
create table known_issue (
    id          uuid primary key default gen_random_uuid(),
    product_id  text,
    title       text not null check (char_length(title) between 1 and 120
                                       and record_plain_text(title, false)),
    body        text not null check (char_length(body) <= 2000
                                       and record_plain_text(body, true)),
    opened_at   timestamptz not null,
    updated_at  timestamptz not null,
    closed_at   timestamptz
);

create index known_issue_open_idx on known_issue (opened_at desc) where closed_at is null;

-- Product-scoped, or global (null product): one changelog entry.
create table changelog_entry (
    id            uuid primary key default gen_random_uuid(),
    product_id    text,
    title         text not null check (char_length(title) between 1 and 120
                                       and record_plain_text(title, false)),
    body          text not null check (char_length(body) <= 4000
                                         and record_plain_text(body, true)),
    published_at  timestamptz not null,
    updated_at    timestamptz not null
);

create index changelog_entry_recent_idx on changelog_entry (published_at desc, id desc);
create index changelog_entry_product_idx on changelog_entry (product_id, published_at desc, id desc);
