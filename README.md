# Minutely OSM data replication for OpenClimbing

Cron runs `updater.sh` every minute:
- calls `src/update.ts` via Bun
- fetches new minutely diffs from https://planet.openstreetmap.org/replication/minute/
- updates `/app/overpass.json.state.json` with current timestamp
- if new climbing data was processed, then:
  - updates the file in `/app/overpass.json`
  - then calls http://localhost:3000/api/climbing-tiles/refresh
  - this has takes `../overpass.json` with priority over OverpassAPI

Runs under `nodeuser`.

## Setup

First prepare initial data by processing the planet.pbf (it could work with overpass seed, but didn't try).

- see https://github.com/zbycz/openclimbing-osmium-import

Then run:
```bash
# in nodeuser
curl -fsSL https://bun.com/install | bash
git clone https://github.com/zbycz/osm-updater.git

# in ubuntu
echo "* *	* * *	nodeuser	bash /home/nodeuser/osm-updater/updater.sh >>/home/nodeuser/update.log 2>&1" | sudo tee -a /etc/crontab
echo "0 4	* * *	nodeuser	rm /home/nodeuser/update.log" | sudo tee -a /etc/crontab

```