# Deploying for 24/7 collection

The local setup only collects data while your computer is awake and the services
are running. For continuous collection + retraining (weeks/months of data), run
the containerized stack on a small always-on host. This is the real fix for
"even when my computer sleeps."

## 1. Provision a host

A tiny box is plenty: **1–2 GB RAM, 1 vCPU, ~20 GB disk**, Ubuntu 22.04+.
Everything here runs on free NYC data — the only cost is the VM.

### Recommended: Oracle Cloud "Always Free" (genuinely $0/month, forever)
Unlike AWS/GCP free tiers (which expire after 12 months), Oracle's Always-Free
tier has no time limit and is generous enough to run this whole stack.

1. Sign up at <https://www.oracle.com/cloud/free/> (needs a card for identity
   verification; Always-Free resources are never charged).
2. **Compute → Instances → Create Instance.**
   - Image: **Canonical Ubuntu 22.04**.
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM) — set **1 OCPU / 6 GB RAM**
     (well within the 4 OCPU / 24 GB Always-Free Arm allowance). If Arm capacity
     is unavailable in your region, **VM.Standard.E2.1.Micro** (AMD) also works.
   - Add your SSH public key (paste `~/.ssh/id_ed25519.pub`; generate with
     `ssh-keygen -t ed25519` if you don't have one).
3. **Networking → open the ports.** In the instance's VCN → Security List (or a
   Network Security Group), add ingress rules for the ports you want reachable
   (at minimum `8080` map+API and `4174` dashboard; `8090/8091/8092` optional).
   Source `0.0.0.0/0` for public, or your home IP `/32` to lock it down.
   Then also open them in the host firewall:
   ```bash
   sudo iptables -I INPUT -p tcp -m multiport --dports 8080,4174,8090,8091,8092 -j ACCEPT
   sudo netfilter-persistent save    # persist across reboots
   ```
4. SSH in: `ssh ubuntu@<public-ip>` and continue to step 2 below.

> **Note (ARM/Ampere):** all Dockerfiles here build from multi-arch base images
> (node, python, rust, golang, debian), so they build natively on ARM64 — no
> changes needed. The first `--build` just takes a few minutes.

Other options if you'd rather pay a few $/mo: Hetzner CX22, DigitalOcean basic
droplet. The steps below are identical once you can SSH in.

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

**Build the map UI too** — `web/dist` is gitignored and bind-mounted (read-only)
into the backend, so on a fresh clone the map would be empty without this step.
No local Node needed — use a throwaway node container writing into `./web`:
```bash
docker run --rm -v "$PWD/web":/w -w /w node:24-slim sh -c "npm ci && npm run build"
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

The compose file sets `PRETRAIN_HISTORY=1`, so every retrain also blends
down-weighted MTA historical running-time rows (cached under
`./data/history_cache/`) into training. This is the measured cold-start fix
(v1 MAE −47.6s on unseen hops, overall flat — `analytics-py/eval_pretrain.py`
is the gate that proved it). First retrain on a fresh host pulls the history
from data.ny.gov once (~1-2 min), then serves from the cache.

## Notes
- **Data lives in `./data`** on the host (bind-mounted) — it survives container
  restarts. Automated backups: `infra/backup.sh` (SQLite online-backup of
  `ledger.db` + the golden-set snapshots, gzip'd, 14-day rotation). Install
  `sqlite3`, `chmod +x infra/backup.sh`, then add to cron:
  `0 3 * * * /path/to/train_tracker/infra/backup.sh >> /var/log/train-tracker-backup.log 2>&1`
- **`ledger.db` size**: at current write volume it runs ~500-600 MB/day; the
  30-day retention prune means it stabilizes around 15-20 GB at steady state
  (well inside Oracle Always-Free's storage allowance). Most of that volume is
  `model-v1` logging every tick even when nothing about its prediction has
  changed except the wall-clock — a known side-effect of the same late-bias
  bug model-v2 fixes (see `fixed_errors.md` I1); `model-v2`'s rows-per-prediction
  is ~9x lower once it's had time to accumulate.
- **Model persistence**: `analytics-py` bind-mounts `./data` too, reads the same
  `ledger.db` the backend writes, and persists the trained model under
  `./data/models/` (`MODEL_DIR`). This is what makes the 6h retrain actually work
  on a restart-happy host — before this the model lived only inside the container
  and every restart sent `/predict` back to 503 until the next retrain.
- **Expose it publicly** (optional): `infra/Caddyfile` (recommended — automatic
  Let's Encrypt TLS, minimal config) or `infra/nginx.conf` (manual certbot) are
  ready to copy onto the VM; edit the placeholder domains and point DNS at the
  VM first. Both proxy the dashboard's three backend dependencies under
  same-origin path prefixes (`/api-backend`, `/api-kalman`, `/api-analytics`)
  so nothing hits mixed-content/insecure-WebSocket blocking once the page is
  served over HTTPS — `dashboard/app.js` and `web/src/main.ts` already branch
  on this automatically (direct-port vs. behind-a-proxy) with no config needed
  on the frontend side. Alternatively, skip TLS entirely: bind ports to
  localhost + use an SSH tunnel for private access.
- **Updating**: `git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.
