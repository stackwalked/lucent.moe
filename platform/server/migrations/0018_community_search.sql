-- Product-scoped, like the guide it indexes: a guide's text is searchable, but results are cut to
-- products the searcher may see when read. Title weighs more than body. PostgreSQL full-text,
-- no search service.
alter table guide add column search tsvector generated always as (
    setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')
) stored;

create index guide_search on guide using gin (search) where removed_at is null;

-- Global: usernames, matched by token prefix with the simple dictionary (no stemming, so a name
-- stays itself). The index expression is the one the query uses.
create index account_username_search on account using gin (to_tsvector('simple', coalesce(username, '')));
