-- Run once on a fresh cluster, before readiness. Only the owner of lucent
-- migrates its schema; the service can't create databases, roles or extensions as superuser.
\getenv password POSTGRES_PASSWORD
CREATE ROLE lucent LOGIN PASSWORD :'password';
ALTER DATABASE lucent OWNER TO lucent;
ALTER ROLE postgres PASSWORD NULL;
