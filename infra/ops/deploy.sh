#!/usr/bin/env bash
# As root: bash infra/ops/deploy.sh after provision and secret entry.
# For operator verbs use the same Compose project and env file:
# docker compose --env-file /etc/lucent/staging.env -f infra/compose.yml run --rm --no-deps platform-server bun src/ops.ts bootstrap-superadmin --email EMAIL --username NAME
# Open the returned setup path on https://lucent.moe; never log/share that path.
# For publish-loader, add -v /trusted/inputs:/inputs:ro and
# -v /var/lib/lucent/artifacts:/artifacts:rw to that run, and use
# --artifact-dir /artifacts with --loader, --host and --seal paths in /inputs.
source "$(dirname -- "$0")/common.sh"
lock_host
compose build platform-server web
compose up -d --no-recreate --wait --wait-timeout 120 postgres
compose run --rm --no-deps -T platform-server bun src/ops.ts migrate
compose up -d --no-deps --wait --wait-timeout 120 platform-server
compose up -d --no-deps --wait --wait-timeout 120 web
# The config is bind-mounted; Compose doesn't hash its contents to detect a change.
compose up -d --no-deps --force-recreate --wait --wait-timeout 120 caddy
