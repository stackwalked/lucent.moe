#!/usr/bin/env bash
# As root on a freshly provisioned host: copy a trusted, private backup to
# /var/backups/lucent/NAME, supply the original keys in /etc/lucent/staging.env,
# then bash infra/ops/restore.sh NAME. Starts only PostgreSQL. Run deploy.sh
# afterwards to migrate/verify and start the apps. No reset or overwrite: if a
# restore fails after DB initialization, investigate and use another empty host.
source "$(dirname -- "$0")/common.sh"
[[ $# == 1 ]] || die "Usage: restore.sh NAME"
lock_host
src=$(backup_path "$1")
[[ -d $src && $(stat -c '%u:%g:%a' "$src") == 0:0:700 ]] || die "Expected a private backup."
entries=("$src"/*)
(( ${#entries[@]} == 3 )) || die "Unexpected backup contents."
regular "$src/complete.sha256"
expected=$(cat -- "$src/complete.sha256")
[[ $expected =~ ^[0-9a-f]{64}$ ]] || die "Incomplete backup."
actual=$(snapshot_digest "$src")
[[ $actual == "$expected" ]] || die "Backup integrity check failed."

containers=$(compose ps -aq)
[[ -z $containers ]] || die "Restore requires a new project with no existing containers."
for dir in postgres artifacts; do
    canonical "$state/$dir"
    [[ -d $state/$dir ]] || die "Provision first."
    entries=("$state/$dir"/*)
    (( ${#entries[@]} == 0 )) || die "Refusing nonempty $dir."
done
compose up -d --no-recreate --wait --wait-timeout 120 postgres
for file in "$src"/artifacts/*; do
    install -o 21001 -g 21100 -m 600 -- "$file" "$state/artifacts/${file##*/}"
done
compose exec -T postgres pg_restore -U postgres --role=lucent --no-owner --no-acl \
    --single-transaction --exit-on-error -d lucent < "$src/db.dump"
