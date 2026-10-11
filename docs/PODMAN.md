# Running Capstone1 with Podman

[Podman](https://podman.io/) is a daemonless, rootless container engine that is
a drop-in replacement for Docker. The project's existing `Dockerfile` and
`docker/Dockerfile.mysql` build **unchanged** under Podman — no image changes
are required.

## 1. Install Podman (Windows)

**Option A — Podman Desktop (recommended):**

```powershell
winget install -e --id RedHat.Podman-Desktop
```

Open Podman Desktop once and let it install the Podman engine + WSL2 backend,
or install the engine directly:

```powershell
winget install -e --id RedHat.Podman
```

**Option B — manual download:** <https://podman-desktop.io/downloads>

## 2. Initialize the Podman machine (one-time, like Docker Desktop's VM)

```powershell
podman machine init
podman machine start
podman --version        # verify
```

> Podman on Windows runs containers inside a lightweight WSL2/Hyper-V "machine".
> The machine must be running (`podman machine start`) before any podman command.

## 3. Configure secrets

```powershell
copy .env.example .env
# then edit .env and set MYSQL_ROOT_PASSWORD and DB_PASSWORD
```

`compose.yaml` reads credentials from `.env`; if they're missing, startup fails
on purpose rather than running with defaults.

## 4. Build and run

```powershell
# Build both images (first run downloads base images and imports Capstone1.sql)
podman compose build

# Start db + web in the background
podman compose up -d

# Watch status / logs
podman ps
podman compose logs -f web
podman compose logs -f db
```

The app is served at **http://localhost:8080** (static Next.js export from
`out/` at `/`, PHP API under `/capstone1/api/`).

> If `podman compose` says no compose provider is found, install either
> `pip install podman-compose` or Docker Compose
> (`winget install -e --id Docker.DockerComposeCLI`) — Podman delegates to it.

## 5. What runs

| Service | Image | Notes |
|---|---|---|
| `db` | `localhost/capstone1-db` | MySQL 8.4; `database/Capstone1.sql` auto-imports on **first** start only (empty volume). Data persists in the `capstone1-mysql-data` volume. |
| `web` | `localhost/capstone1-web` | PHP 8.2 + Apache; waits for `db` healthcheck. Uploads persist in `capstone1-uploads` volume. |

The web container reaches MySQL at host `db` (compose network DNS) —
`api/config.php` picks this up via the `DB_HOST` env var, no code changes.

MySQL is published on **127.0.0.1:3307** (not 3306) so it can't collide with a
local XAMPP MySQL while still letting phpMyAdmin/HeidiSQL connect if needed.

## 6. Day-to-day commands

```powershell
podman stop capstone1-web capstone1-db        # stop
podman compose up -d                          # start again
podman compose up -d --build web              # rebuild after Dockerfile/API changes
podman compose down                           # stop + remove containers (volumes kept)
podman compose down -v                        # ⚠ also wipes the database volume → re-import on next start
podman volume ls                              # list volumes
podman exec -it capstone1-db mysql -uroot -p   # MySQL shell
podman machine stop                           # shut the VM down when done for the day
```

## 7. Docker compatibility cheat-sheet

| Docker | Podman |
|---|---|
| `docker build -t x .` | `podman build -t x .` |
| `docker run ...` | `podman run ...` |
| `docker compose up` | `podman compose up` |
| `docker ps` | `podman ps` |
| `docker exec ...` | `podman exec ...` |
| `.dockerignore` | `.containerignore` (already added) |
| Docker Desktop daemon | Rootless, daemonless — no background service |

Podman also understands `Containerfile` (its native name) and can run Kubernetes
YAML via `podman play kube` if you ever want to move toward k8s/OpenShift.

## 8. Gotchas on this project

- **Rebuild after `npm run build`:** the image bakes in the contents of `out/`
  and `api/` at build time — changed API code requires
  `podman compose up -d --build web`.
- **First DB start only:** `database/Capstone1.sql` is imported only when the
  `capstone1-mysql-data` volume is empty. To reset: `podman compose down -v`.
- **`scripts/create_llb_app_user.sql` is XAMPP-specific** (`@'127.0.0.1'`) and
  does *not* apply inside containers; the `MYSQL_USER`/`MYSQL_PASSWORD` env vars
  in `compose.yaml` create the in-container app user instead.
- **SMTP** (`api/mailer.php`) needs `SMTP_USERNAME`/`SMTP_PASSWORD` in `.env`
  (Gmail app password) for password-reset emails to work.
