-- Sessions an owner can list and end one by one, and the client each session and audit entry
-- came from: web reports the IP and user agent it saw (`Lucent-Client`).

-- Sessions are disposable, and none predating `public_id` could be listed; their holders sign in
-- again. Flows tied to them go with them.
delete from browser_session;

alter table browser_session
    add column public_id     text not null unique,
    add column client_ip     inet,
    add column user_agent    text check (length(user_agent) <= 512),
    add column last_seen_at  timestamptz not null;

alter table audit
    add column client_ip   inet,
    add column user_agent  text check (length(user_agent) <= 512);
