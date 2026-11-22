#!/usr/bin/env bash
# As root: bash infra/ops/backup.sh NAME. Writes /var/backups/lucent/NAME,
# never overwrites. Copy the whole completed directory to private off-host
# storage. This database dump is sensitive and not encrypted by this script.
# Keep staging keys separately. A failed backup lacks a valid seal; use a new
# name. Never prune the artifact store while backing up.
source "$(dirname -- "$0")/common.sh"
[[ $# == 1 ]] || die "Usage: backup.sh NAME"
lock_host
dest=$(backup_path "$1")
canonical "$state/artifacts"
[[ -d $state/artifacts ]] || die "Missing artifact store."
mkdir -- "$dest" "$dest/artifacts"
# publish-loader writes by digest BEFORE committing the release. Taking the DB
# snapshot first means every referenced file exists; concurrent publishes can
# add harmless extra files. The seal covers the copies, not the live originals.
compose exec -T postgres pg_dump -U postgres -d lucent -Fc > "$dest/db.dump"
for file in "$state"/artifacts/*; do
    artifact "$file"
    install -m 600 -- "$file" "$dest/artifacts/${file##*/}"
done
seal=$(snapshot_digest "$dest")
printf '%s\n' "$seal" > "$dest/complete.sha256"
