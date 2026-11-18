#!/bin/sh
# Installs the Cockpit layout and its mods into your Herdr home, then switches to it.
# Run it again to update. Nothing of yours is replaced: only the cockpit-* mods and the
# cockpit layout are overwritten, and your own keys in keys.json win.
#
#   ./install.sh            install or update
#   ./install.sh --force    also replace a different `usage-limits` mod you already have
set -e
HERE="$(cd "$(dirname "$0")" && pwd)/cockpit"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

[ -d "$HOME_DIR/mods" ] || { echo "Herdr's folder is not at $HOME_DIR. Open the Herdr app once, then run this again."; exit 1; }

for mod in "$HERE"/mods/*/; do
  name=$(basename "$mod"); dest="$HOME_DIR/mods/$name"
  case "$name" in
    cockpit-*) ;;
    *) # A mod that is not ours by name (usage-limits): keep a different copy unless --force.
      if [ -d "$dest" ] && [ "$FORCE" = 0 ] && ! diff -rq -x '*.d.ts' -x jsconfig.json "$mod" "$dest" >/dev/null 2>&1; then
        echo "  kept      your own mods/$name (run with --force to replace it)"; continue
      fi ;;
  esac
  # mod.json goes first: a folder Herdr sees without it gets docked into the shown layout.
  mkdir -p "$dest"; cp "$mod/mod.json" "$dest/mod.json"
  cp -R "$mod/." "$dest/"
  echo "  installed mods/$name"
done

mkdir -p "$HOME_DIR/layouts"
cp "$HERE/layouts/cockpit.json" "$HERE/layouts/cockpit.svg" "$HOME_DIR/layouts/"
echo "  installed layouts/cockpit.json"

# keys.json: add the mod's shortcuts where you have none of your own for that key.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$HERE/keys.json" "$HOME_DIR/keys.json" <<'PY'
import json, os, sys
theirs = json.load(open(sys.argv[1]))
path = sys.argv[2]
mine = json.load(open(path)) if os.path.exists(path) else {}
added = 0
for section, keys in theirs.items():
    have = mine.setdefault(section, {})
    for key, action in keys.items():
        if key not in have:
            have[key] = action
            added += 1
if added:
    json.dump(mine, open(path, "w"), indent=2)
print(f"  keys.json  {added} shortcut(s) added" if added else "  keys.json  already has the shortcuts")
PY
else
  echo "  keys.json  python3 not found: add the section from cockpit/keys.json by hand"
fi

if command -v herdr-app >/dev/null 2>&1 && herdr-app do layout.switch --name cockpit >/dev/null 2>&1; then
  echo "Done. Herdr is showing the Cockpit layout (cmd-shift-l switches back)."
else
  echo "Done. In Herdr, switch layouts with cmd-shift-l until Cockpit shows."
fi
