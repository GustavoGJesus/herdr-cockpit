#!/bin/sh
# Copies the layout and its mods from your Herdr home into this repo, so a commit captures
# what you run. Leaves out the files Herdr writes itself.
set -e
cd "$(dirname "$0")"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
cp "$HOME_DIR/layouts/cockpit.json" "$HOME_DIR/layouts/cockpit.svg" cockpit/layouts/
for mod in "$HOME_DIR"/mods/cockpit-* "$HOME_DIR/mods/usage-limits"; do
  name=$(basename "$mod")
  mkdir -p "cockpit/mods/$name"
  rsync -a --delete --exclude gpui-kit.d.ts --exclude herdr.d.ts --exclude jsconfig.json \
    --exclude node_modules --exclude .cache --exclude .DS_Store "$mod/" "cockpit/mods/$name/"
  echo "synced $name"
done
# Mods that left the Herdr home leave the repo too.
for mod in cockpit/mods/*/; do
  [ -d "$HOME_DIR/mods/$(basename "$mod")" ] || { rm -rf "$mod"; echo "removed $(basename "$mod")"; }
done
