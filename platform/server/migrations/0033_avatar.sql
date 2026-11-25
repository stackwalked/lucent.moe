-- Global: an avatar belongs to a profile, and a profile to one account whatever the product.
-- One row per stored WebP, keyed by the SHA-256 of its bytes, so two accounts that upload the
-- same picture share it. The bytes were re-encoded from pixels by the decoder child, never kept
-- as uploaded. A writer that stops a profile naming an image deletes it in the same transaction
-- once no profile names it; nothing else deletes these rows.
create table avatar_image (
    digest     text primary key check (digest ~ '^[0-9a-f]{64}$'),
    bytes      bytea not null check (length(bytes) between 1 and 2097152),
    created_at timestamptz not null default now()
);

-- The profile's two sizes: 256 px for its page, 64 px beside what it wrote. Both or neither.
-- Removal by a moderator clears them with the bio.
alter table profile
    add column avatar_large text references avatar_image (digest),
    add column avatar_small text references avatar_image (digest),
    add constraint profile_avatar_pair check ((avatar_large is null) = (avatar_small is null));

create index profile_avatar_large on profile (avatar_large) where avatar_large is not null;
create index profile_avatar_small on profile (avatar_small) where avatar_small is not null;
