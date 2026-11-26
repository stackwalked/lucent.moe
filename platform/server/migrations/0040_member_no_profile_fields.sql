-- Piece 1 of community: the member number, the new profile fields and privacy opt-outs, and the
-- Discord handle on the link.

-- Global: a positive number per account, unique and never reused, so members can be named and
-- sorted by a small number that survives every rename. Existing accounts are numbered in
-- created_at order (ties by id); the sequence then starts past the backfill's maximum and every
-- new account takes its number from the column default, which is the sequence's nextval -- no
-- insert needs to name it. A tombstone keeps its number (the strip in deletion/strip.ts touches
-- no member_no).
create sequence account_member_no_seq;

alter table account
    add column member_no bigint unique check (member_no > 0);

with numbered as (
    select id, row_number() over (order by created_at, id) as n from account
)
update account a set member_no = numbered.n from numbered where a.id = numbered.id;

alter table account alter column member_no set not null;
select setval('account_member_no_seq', (select max(member_no) from account));
alter table account alter column member_no set default nextval('account_member_no_seq');

-- Global: the profile's tagline (one line beside the name) and banner (a digest into
-- avatar_image, the same store avatars use, so the same staff removal path and the same
-- visibility rule apply). The six opt-outs are what other members may see on the profile; the
-- owner always sees everything. Default true: shown, as profiles were before the switches.
alter table profile
    add column tagline text not null default '' check (length(tagline) <= 80 and tagline !~ '[\r\n]'),
    add column banner text references avatar_image (digest),
    add column show_invited_by boolean not null default true,
    add column show_invited boolean not null default true,
    add column show_products boolean not null default true,
    add column show_last_seen boolean not null default true,
    add column show_discord boolean not null default true,
    add column show_wall boolean not null default true;

-- Global: the Discord user's handle as Discord showed it when the link was made or last synced.
-- Null for links older than this column and for a connector that does not send it yet.
alter table connector_discord_link
    add column username text check (username is null or length(username) between 1 and 64);
