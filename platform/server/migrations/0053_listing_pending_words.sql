-- A script runs code, so what its listing says about it is approved with it: a change to the
-- summary or description of a listed script waits here, beside the visible words, until staff
-- approve it together with any pending revision. Both are set or neither. `pending_version`
-- counts every change to what waits (revision or words), and never goes back: staff approve the
-- version they read, so a change made after they read is refused as stale.
alter table cloud_listing
    add column pending_summary text
        check (length(pending_summary) <= 140 and pending_summary !~ '[\r\n]'),
    add column pending_description text check (length(pending_description) <= 2000),
    add column pending_version integer not null default 0,
    add constraint cloud_listing_pending_words
        check ((pending_summary is null) = (pending_description is null));

-- First scripts already waiting have a version to be approved by.
update cloud_listing set pending_version = 1 where pending_revision is not null;

drop index cloud_listing_pending;
create index cloud_listing_pending on cloud_listing (updated_at, id)
    where state <> 'removed' and (pending_revision is not null or pending_summary is not null);
