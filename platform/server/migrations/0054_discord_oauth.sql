-- Discord is linked through OAuth instead of a code typed into /link: an applicant authorizes
-- Discord on the form, which also joins them to the guild, and the link transfers to their account
-- when staff approve. Nothing is left of the codes.

drop table connector_discord_link_code;

-- Global. A Discord user an applicant proved they are by authorizing Discord, held by the SHA-256
-- of the token the browser keeps, for an hour: until an application takes it (the row is
-- deleted) or it expires.
create table application_discord_claim (
    token_hash       bytea primary key check (length(token_hash) = 32),
    discord_user_id  text not null check (discord_user_id ~ '^[1-9][0-9]{16,19}$'),
    username         text not null check (length(username) between 1 and 64),
    expires_at       timestamptz not null
);

-- Null: the handle as typed, which nothing verified (an application made before this, or on a
-- server with no Discord application).
alter table application
    add column discord_user_id text check (discord_user_id ~ '^[1-9][0-9]{16,19}$');

-- The form no longer asks for a handle: a server with no Discord application stores none (empty),
-- and only a verified one, Discord's own, is held to Discord's two to 32 characters. Applications
-- made before this keep the handle they typed.
alter table application drop constraint application_form_check;
alter table application
    add constraint application_form_check
        check (experience = ''
               or (char_length(discord) <= 32
                   and (discord_user_id is null or char_length(discord) between 2 and 32)
                   and char_length(experience) between 1 and 1000
                   and char_length(games) between 1 and 300
                   and (additional is null or char_length(additional) between 1 and 1000)));

-- One waiting application per Discord user, whatever address it came under.
create unique index application_pending_discord_idx on application (discord_user_id)
    where state = 'pending';
