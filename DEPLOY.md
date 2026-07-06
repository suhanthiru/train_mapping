# Deploying for 24/7 collection

The local setup only collects data while your computer is awake and the services
are running. For continuous collection + retraining (weeks/months of data), run
the containerized stack on a small always-on host. This is the real fix for
"even when my computer sleeps."

## 1. Provision a host
A tiny VPS is plenty: **1–2 GB RAM, 1 vCPU, ~20 GB disk**, Ubuntu 22.04+.
(e.g. Hetzner CX22, DigitalOcean basic droplet, or an Oracle Cloud always-free VM.)
Everything here runs on free NYC data — the only cost is the VM.

## 2. Install Docker
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in so `docker` works without sudo
```

## 3. Get the code
```bash
git clone <your-repo-url> train_tracker && cd train_tracker
```

## 4. One-time data prep (the repo ignores generated data)
The static geometry and elevation data aren't in git. Generate them once into the
mounted `data/` folder using the backend image (no local Node needed):
```bash
docker compose build backend
docker compose run --rm backend npm run preprocess:nyc          # GTFS geometry (required)
docker compose run --rm backend npm run preprocess:osm-layers   # elevation (optional feature)
docker compose run --rm backend npm run preprocess:osm-match
```

## 5. Launch the stack (auto-restarting)
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```
All five services come up and stay up across crashes and reboots. Ports:
- `:8080` map + API · `:4174` analytics dashboard · `:8090/8091/8092` Go/Python/Rust

## 6. The model trains itself
`analytics-py` retrains every 6h from the growing ledger and hot-reloads with no
downtime. To kick a first training immediately once some data has accrued:
```bash
curl -X POST http://localhost:8091/retrain
```

## Notes
- **Data lives in `./data`** on the host (bind-mounted) — it survives container
  restarts. Back it up (or rely on the periodic Parquet golden-set snapshots in
  `data/exports/goldenset/`, which are prune-immune).
- **Expose it publicly** (optional): put nginx/Caddy in front for TLS, or bind the
  ports to localhost + use an SSH tunnel. Service URLs are already env-driven.
- **Updating**: `git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.
