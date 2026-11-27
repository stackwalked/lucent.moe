-- What an owner says about a listing beside its one-line summary: plain text with its line breaks,
-- shown on the listing's own page. Changing it never sends a script back to staff; only a changed
-- revision does.
alter table cloud_listing
    add column description text not null default '' check (length(description) <= 2000);
