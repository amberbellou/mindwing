#!/bin/sh
# One-time production deploy for the Mindwing API.
# Generates SESSION_SECRET and ADMIN_KEY (first run only), stores them outside the repo
# in ~/.config/mindwing (readable only by you), uploads them as Worker secrets, then deploys.
set -e
cd "$(dirname "$0")"
DIR="$HOME/.config/mindwing"
mkdir -p "$DIR" && chmod 700 "$DIR"
[ -f "$DIR/session-secret" ] || { openssl rand -base64 48 > "$DIR/session-secret"; NEW=1; }
[ -f "$DIR/admin-key" ] || { openssl rand -hex 24 > "$DIR/admin-key"; NEW=1; }
chmod 600 "$DIR/session-secret" "$DIR/admin-key"

# Apply any new database migrations first: new Worker code may rely on new tables or columns,
# while the old code keeps working with them. Already-applied migrations are skipped.
yes | npx wrangler d1 migrations apply mindwing --remote
npx wrangler deploy
if [ -n "$NEW" ] || [ "$1" = "--secrets" ]; then
  npx wrangler secret put SESSION_SECRET < "$DIR/session-secret"
  npx wrangler secret put ADMIN_KEY < "$DIR/admin-key"
fi
echo
echo "Deployed. Admin key for data export is saved at: $DIR/admin-key"
