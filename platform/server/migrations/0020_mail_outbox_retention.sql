-- Global delivery queue, not product-scoped. A settled row (accepted or dead) is kept for its
-- retention period (30 days accepted, 90 dead; jobs/retention.ts) and holds no address, text or
-- link, only what staff need to reconcile it: kind, state and times.
--
-- Before this, a dead reset mail kept `reset_hash` and went with its link (on delete cascade),
-- leaving only the audit row. Settling a row now clears `reset_hash`; the cascade stays for the
-- rows still waiting, whose mail must not outlive the link it carries.
alter table mail_outbox add column kind text not null default 'notice' check (kind in ('notice', 'reset'));
update mail_outbox set kind = 'reset' where reset_hash is not null;
update mail_outbox set reset_hash = null where state in ('accepted', 'dead');
alter table mail_outbox add check (state in ('pending', 'sending') or reset_hash is null);
alter table mail_outbox add check (reset_hash is null or kind = 'reset');
create index mail_outbox_finished on mail_outbox (state, finished_at) where finished_at is not null;
