-- A changelog entry may name the release it describes, so the site can show a release's version:
-- releases carry a seal number and no version of their own, the entry's version is the release's.
-- One entry per release; an entry that names a release names its version too. That the entry's
-- subject matches the release's product is the writer's rule (notes.rules.ts), not a check:
-- it spans two tables. A release that is deleted leaves its entry standing, release-less.

alter table changelog_entry
    add column release_id bytea references release (id) on delete set null,
    add constraint changelog_entry_release_version_check
        check (release_id is null or version is not null);

create unique index changelog_entry_release_idx on changelog_entry (release_id)
    where release_id is not null;
