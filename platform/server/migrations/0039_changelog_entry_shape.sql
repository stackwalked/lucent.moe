-- Changelog entries gain a subject (a product, the loader, or the service), an optional version
-- as the release names itself, and added/changed/fixed lists; the title becomes optional
-- (notes.ts, rpc/web/record.ts). The loader's entries are the service's in kind but their own in
-- subject, so a product_id of 'lucent-loader' folds into subject 'loader' with no product.
--

alter table changelog_entry
    add column subject text,
    add column version text,
    add column added text[] not null default '{}',
    add column changed text[] not null default '{}',
    add column fixed text[] not null default '{}';

update changelog_entry set subject = 'service' where product_id is null;
update changelog_entry set subject = 'loader', product_id = null where product_id = 'lucent-loader';
update changelog_entry set subject = 'product' where subject is null;

alter table changelog_entry alter column subject set not null;
alter table changelog_entry alter column title drop not null;

-- One line of 1 to 200 plain characters, as titles are written.
create function record_lines(value text[]) returns boolean
language sql immutable as $$
    select cardinality(value) <= 30
       and not exists (select 1 from unnest(value) as line
                       where char_length(line) not between 1 and 200
                          or not record_plain_text(line, false))
$$;

alter table changelog_entry
    add constraint changelog_entry_subject_check
        check (subject in ('product', 'loader', 'service')),
    add constraint changelog_entry_subject_product_check
        check ((product_id is not null) = (subject = 'product')),
    add constraint changelog_entry_version_check
        check (version is null or (char_length(version) between 1 and 40
                                     and record_plain_text(version, false))),
    add constraint changelog_entry_named_check
        check (title is not null or version is not null),
    -- Rows written before this shape can be title-only; the rule binds new and updated rows.
    add constraint changelog_entry_content_check
        check (body <> '' or cardinality(added) > 0 or cardinality(changed) > 0
               or cardinality(fixed) > 0) not valid,
    add constraint changelog_entry_added_check check (record_lines(added)),
    add constraint changelog_entry_changed_check check (record_lines(changed)),
    add constraint changelog_entry_fixed_check check (record_lines(fixed));

-- Member reads page by subject, newest first.
create index changelog_entry_subject_idx on changelog_entry (subject, published_at desc, id desc);
