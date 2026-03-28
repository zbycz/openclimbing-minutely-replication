export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

echo "updater.sh starts at $(date)..."

cd /home/nodeuser
flock -n /tmp/osm-update.lock -c 'bun run osm-updater/src/update.ts /app/overpass.json /app/overpass.json && curl --max-time 30 -sS -i http://localhost:3000/api/climbing-tiles/refresh'

echo
echo "END $(date)"
echo "-----------------------------------------------"

# flock -n -- doesn't wait, just exits when already running. Important for cron. Risk: neverending updater, but hopeful it is fine.

#CRON:
# * *     * * *   nodeuser        bash /home/nodeuser/updater.sh >>/home/nodeuser/updater.log 2>&1
# 0 4     * * *   nodeuser        rm /home/nodeuser/updater.log

