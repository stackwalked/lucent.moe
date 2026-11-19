-- The name a member gives their PC, so a list of them reads as theirs rather than as match codes.
-- Null until they name it.
alter table device add column name text check (name is null or length(name) between 1 and 64);
