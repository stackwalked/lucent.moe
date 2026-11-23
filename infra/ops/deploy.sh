#!/usr/bin/env bash
# As root: bash infra/ops/deploy.sh after provision and secret entry.
#
# Deploy has a short outage and no automatic rollback. Compose stops the old
# platform-server (then web) before it starts the new one, so requests fail for the
# length of the swap. A new instance that never turns healthy leaves nothing
# serving: the script exits non-zero naming the service after 120s, and the fix is
# forward (repair and redeploy, or deploy the previous commit). Postgres is not
# touched by a normal deploy.
#
# Migrations must be expand-only for one deploy. `ops migrate` runs before the new
# platform starts, and each migration commits on its own. Once one has applied, the
# previous platform build can no longer start: it exits on SCHEMA_AHEAD and
# `restart: unless-stopped` loops it. A migrate that fails part-way keeps the
# migrations it already committed, so it is fixed forward as well; there is no
# stepping back to the old build.
#
# For operator verbs use the same Compose project and env file:
# docker compose --env-file /etc/lucent/staging.env -f infra/compose.yml run --rm --no-deps platform-server bun src/ops.ts bootstrap-superadmin --email EMAIL --username NAME
# Open the returned setup path on https://lucent.moe; never log/share that path.
#
# publish-loader writes the artifact store, which platform-server mounts read-only,
# so it runs as the platform-ops service (same image and environment, store
# mounted read-write; Compose rejects a second mount on an existing target):
# docker compose --env-file /etc/lucent/staging.env -f infra/compose.yml run --rm --no-deps -v /trusted/inputs:/inputs:ro platform-ops bun src/ops.ts publish-loader --artifact-dir /artifacts --loader /inputs/LOADER --host /inputs/HOST --seal /inputs/SEAL
# Run it after a deploy has built platform-server: platform-ops reuses that image.
source "$(dirname -- "$0")/common.sh"
lock_host

healthy() {
    local service=$1
    compose up -d --no-deps --wait --wait-timeout 120 "$service" ||
        die "deploy failed: $service did not become healthy within 120s; nothing rolls back (docker compose --env-file $envfile -f $infra/compose.yml logs $service)"
}

compose build platform-server web
# --no-recreate: a deploy never restarts the database, so edits to the postgres
# service in compose.yml (image, command, environment) do NOT take effect here.
# To apply one deliberately, accepting a database restart and a platform outage:
# docker compose --env-file /etc/lucent/staging.env -f infra/compose.yml up -d --no-deps --force-recreate --wait postgres
compose up -d --no-recreate --wait --wait-timeout 120 postgres
compose run --rm --no-deps -T platform-server bun src/ops.ts migrate
healthy platform-server
healthy web

# The config is bind-mounted, so Compose doesn't hash its contents; an image or
# compose.yml change recreates caddy by itself. Recreating drops live connections
# (admin is off, so there is no reload), hence only when the config digest changed.
stamp=$state/caddy-config.sha256
config_digest=$(cd -- "$infra/caddy" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
if [[ ! -f $stamp || $(cat -- "$stamp") != "$config_digest" ]]; then
    compose up -d --no-deps --force-recreate --wait --wait-timeout 120 caddy ||
        die "deploy failed: caddy did not become healthy within 120s; nothing rolls back"
else
    healthy caddy
fi
printf '%s\n' "$config_digest" > "$stamp.tmp"
mv -- "$stamp.tmp" "$stamp"
