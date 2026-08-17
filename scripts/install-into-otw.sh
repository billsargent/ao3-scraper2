#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/otw-importer"
OTW_DIR="${1:?Usage: scripts/install-into-otw.sh /path/to/otwarchive}"

for file in "$SOURCE_DIR"/app/models/*.rb; do
  cp "$file" "$OTW_DIR/app/models/"
done
mkdir -p "$OTW_DIR/app/services/preservation_import" "$OTW_DIR/spec/services/preservation_import"
cp "$SOURCE_DIR"/app/services/preservation_import/*.rb "$OTW_DIR/app/services/preservation_import/"
cp "$SOURCE_DIR"/spec/services/preservation_import/*.rb "$OTW_DIR/spec/services/preservation_import/"
cp "$SOURCE_DIR"/lib/tasks/preservation_import.rake "$OTW_DIR/lib/tasks/"
cp "$SOURCE_DIR"/db/migrate/*.rb "$OTW_DIR/db/migrate/"
cp "$SOURCE_DIR"/config_initializer.rb "$OTW_DIR/config/initializers/preservation_import.rb"
cp "$SOURCE_DIR"/docker-compose.low-memory.yml "$OTW_DIR/docker-compose.preservation-test.yml"
mkdir -p "$OTW_DIR/spec/fixtures/preservation"
cp -R "$SOURCE_DIR"/../fixtures/package-v1 "$OTW_DIR/spec/fixtures/preservation/"
cp -R "$SOURCE_DIR"/../fixtures/package-v1-update "$OTW_DIR/spec/fixtures/preservation/"

echo "Installed preservation importer overlay and fixtures into $OTW_DIR"
