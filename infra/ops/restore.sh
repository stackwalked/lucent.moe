#!/usr/bin/env bash
# As root on a freshly provisioned host: copy a trusted, private backup to
# /var/backups/lucent/NAME, supply the original keys in /etc/lucent/staging.env,
# then bash infra/ops/restore.sh NAME. Starts only PostgreSQL. Run deploy.sh
# afterwards to migrate/verify and start the apps. No reset or overwrite of a
# host that holds data: the checks below refuse any existing container or
# nonempty postgres/artifacts directory.
# Artifacts are staged in $state/artifacts.restoring and moved over the empty
# artifacts directory only after pg_restore succeeded. If the restore fails after
# PostgreSQL was started, the script removes what this run created (the project's
# containers, the postgres data it initialised, the staging directory) so the same
# command can be retried. If that cleanup itself fails it prints the exact commands
# and exits non-zero. pg_restore runs with --clean --if-exists: the provisioned
# database already holds objects a dump can recreate (the public schema and its
# comment), and a plain restore would stop on them.
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
staging=$state/artifacts.restoring
canonical "$staging"
# Only an earlier run of this script leaves this behind.
rm -rf -- "$staging"
install -d -o 21001 -g 21100 -m 700 -- "$staging"
for file in "$src"/artifacts/*; do
    install -o 21001 -g 21100 -m 600 -- "$file" "$staging/${file##*/}"
done

# Armed only now: everything it removes was verified empty or created by this run.
abandon() {
    local status=$?
    trap - EXIT
    if (( status == 0 )); then
        return 0
    fi
    printf '%s\n' "Restore failed; returning the host to its provisioned state." >&2
    if compose down --remove-orphans &&
        find "$state/postgres" -mindepth 1 -delete &&
        rm -rf -- "$staging"; then
        printf '%s\n' "Host is clean; the same command can be retried." >&2
    else
        printf '%s\n' "Cleanup failed. As root, run:" \
            "  docker compose --env-file $envfile -f $infra/compose.yml down --remove-orphans" \
            "  find $state/postgres -mindepth 1 -delete" \
            "  rm -rf -- $staging" \
            "then retry." >&2
    fi
    exit "$status"
}
trap abandon EXIT

compose up -d --no-recreate --wait --wait-timeout 120 postgres
compose exec -T postgres pg_restore -U postgres --role=lucent --no-owner --no-acl \
    --clean --if-exists --single-transaction --exit-on-error -d lucent < "$src/db.dump"
rmdir -- "$state/artifacts"
mv -- "$staging" "$state/artifacts"
