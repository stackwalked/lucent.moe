-- The application form asks for a Discord handle, experience with other providers and the games
-- played actively, and no longer for the products wanted or "about you" (rpc/web/waitlist.ts).
-- What an applicant wrote as "about you" stays, as "additional info", so nothing staff have read
-- is lost.

alter table application
    add column experience text not null default '',
    add column games text not null default '',
    add column additional text;

-- The old limit refused an empty handle.
alter table application drop constraint application_discord_check;

update application set additional = about;
update application set discord = '' where discord is null;

alter table application
    alter column experience drop default,
    alter column games drop default,
    alter column discord set not null,
    drop column about,
    drop column products;

-- An application made before this form has an empty experience and the old limits on the rest.
-- Every row update (a decision, the removal of a deleted member's name from known_by) is checked
-- against this, so those rows are exempt by what marks them: no experience. The form never
-- submits one without.
alter table application
    add constraint application_form_check
        check (experience = ''
               or (char_length(discord) between 2 and 32
                   and char_length(experience) between 1 and 1000
                   and char_length(games) between 1 and 300
                   and (additional is null or char_length(additional) between 1 and 1000)));
