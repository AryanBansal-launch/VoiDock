# VoiDock 🐳

**On-demand container orchestration with a management UI, deployable either as a self-hosted Docker daemon or serverless on Vercel.**

VoiDock spins up isolated workloads on demand and gives each one a routable URL — via a REST API or a dashboard. Launch a container, get back `http://your-app.localhost` (self-hosted) or `https://sb-xxxxxxxx.vercel.run` (Vercel), and manage its lifecycle from there.

## What it does

- **Launch on demand** — `POST /container {"image": "nginx", "tag": "latest"}`, no compose file needed
- **Routable by default** — every workload gets a URL the moment it's ready
- **Full lifecycle control** — start, stop, restart, delete, tail logs
- **Automatic image pulling** — any Docker Hub image, private registry, or custom build
- **Auto-cleanup** — workloads don't outlive their container

## Quickstart

Pick one:

**Self-hosted, own Docker daemon:**
```bash
git clone https://github.com/AryanBansal-launch/VoiDock.git
cd VoiDock
cp .env.example .env   # VOIDOCK_DRIVER=docker (default)
docker compose up -d --build
```
Dashboard: `http://localhost:8080`

**Vercel, no Docker daemon of your own:**
```bash
npx vercel link
npx vercel env pull
npx vercel deploy --prod
```
Enable **OIDC Federation** in Project Settings → Security first — see [Deploying to Vercel](#deploying-to-vercel).

## Drivers

The API and dashboard are backend-agnostic. A **driver** decides how a workload actually runs; both return identical records, so nothing above them changes.

| | `docker` | `sandbox` |
| --- | --- | --- |
| Runtime | Containers on a Docker daemon | One [Vercel Sandbox](https://vercel.com/docs/sandbox) microVM per workload, each running its own `dockerd` |
| Needs `/var/run/docker.sock` | Yes | No |
| Routing | VoiDock's reverse proxy on `:80` → `<name>.<REVERSE_PROXY_HOST>` | `sandbox.domain(port)` → public `https://<sub>.vercel.run` |
| Raw TCP passthrough (non-HTTP images) | Yes — `port` on `POST /container` | No — Vercel Sandbox only exposes HTTP(S) |
| Runs on Vercel | No | Yes |
| Workload lifetime | Until stopped | Until `SANDBOX_TIMEOUT_MS` (45 min Hobby / 24 h Pro) |
| Selected by | `VOIDOCK_DRIVER=docker`, or no `VERCEL` env var | `VOIDOCK_DRIVER=sandbox`, or auto when `VERCEL` is set |

See [drivers/README.md](drivers/README.md) for the contract a driver implements.

### Running Non-HTTP Workloads

Redis, Postgres, Kafka, and anything else that isn't an HTTP server.

`docker` driver only — the `sandbox` driver can never do this, see the table above.

1. Launch with `port` set to the image's internal service port. Some images also
   need `env` — verified live, not assumed: bare `postgres` and `mysql` refuse to
   even boot without a credential passed this way:
   ```bash
   curl -X POST /container -H "Content-Type: application/json" \
     -d '{"image":"redis","tag":"alpine","port":6379}'

   curl -X POST /container -H "Content-Type: application/json" \
     -d '{"image":"postgres","tag":"16","port":5432,"env":{"POSTGRES_PASSWORD":"changeme"}}'
   ```
2. Connect with the service's own client using the `tcpAddress` from the
   response — `redis-cli -h <host> -p <port>`, `psql -h <host> -p <port> -U postgres`.
   It's a raw TCP passthrough, not a URL — a browser won't work.
3. Re-check `tcpAddress` from `GET /list` after any stop/restart; the host port
   isn't stable across one (Docker re-randomizes it).

**What actually boots**, verified live except where noted:

| Image | Boots without `env`? |
| --- | --- |
| redis, mongo, memcached, rabbitmq | Yes — insecure-but-functional defaults |
| postgres | No — needs `POSTGRES_PASSWORD` |
| mysql | No — needs `MYSQL_ROOT_PASSWORD` (or `MYSQL_ALLOW_EMPTY_PASSWORD`) |
| bitnami/kafka (KRaft mode) | Likely no — several `KAFKA_CFG_*` vars, per Bitnami's docs, not independently verified here |

**Security — read before pointing this at anything real.** Publishing a port
binds it to `0.0.0.0` on the host: anyone who can reach the host on that port
connects directly, with zero authentication from VoiDock (the management API
itself has none either — see [Capabilities](#capabilities)). This is the same
trust model as the HTTP proxy, just extended to more protocols — but the stakes
are higher when what's exposed is a database.

- Firewall the ephemeral port range to trusted sources, or keep the whole host
  behind a VPN/private network — don't expose it to the open internet as-is
- Always set a real credential via `env`, even for local testing — don't rely on
  network isolation alone
- For anything you actually care about, don't run the database through VoiDock —
  use a managed service (Neon, Upstash, RDS, ...) and point your app at it directly

### Deploying to Vercel

Vercel Functions can't reach a Docker socket and can't bind two ports, so the `docker` driver cannot run there. The `sandbox` driver exists for that case: it drives Vercel Sandbox microVMs, which explicitly support system-privileged processes like `dockerd`.

1. `npx vercel link`
2. Create a [Vercel access token](https://vercel.com/account/tokens) and set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` in Project Settings → Environment Variables (Production + Preview) — see `.env.example` for exactly where each ID comes from
3. Set the other sandbox env vars below too
4. `npx vercel deploy --prod` — [Dockerfile.vercel](Dockerfile.vercel) is auto-detected

**Toggling "OIDC Federation" in Project Settings → Security does *not* fix credentials here** — worth stating plainly since it's the natural first thing to try, and it's a dead end. That toggle only wires up Vercel's *own* Node.js/Edge function runtime to inject the OIDC token per-request. `Dockerfile.vercel` runs a plain Express server that Vercel just forwards raw HTTP traffic to — it never receives that per-request context, so the SDK's automatic OIDC path can't succeed no matter what's enabled. The explicit access token above is the only thing that actually works here, confirmed by reading `@vercel/oidc`'s own source: its OIDC lookup depends on a `globalThis` symbol only Vercel's standard function runtime populates.

For local runs against real sandboxes: `npx vercel env pull` writes `.env.local` with a short-lived `VERCEL_OIDC_TOKEN` (12 hours) — that one's fine for local dev, since the SDK's local fallback path is different from the production one and doesn't hit this issue.

Trade-offs worth knowing before you pick this path:

- **Workloads are not permanent** — every sandbox has a hard maximum lifetime
- **Cold creates are slow** (30-60s+) — installing Docker and pulling the image happens per sandbox. A [custom VCR image](https://vercel.com/docs/sandbox/concepts/images) with Docker preinstalled removes most of this
- **Concurrency is capped** — 10 sandboxes on Hobby, 2,000 on Pro
- **`iad1` region only**, no Secure Compute or static IPs

## Configuration

Copy [.env.example](.env.example) to get started:
```bash
cp .env.example .env
```

`npm start` loads `.env`, then `.env.local` on top of it (so `.env.local` wins), via Node's built-in `--env-file-if-exists` — no `dotenv` dependency. Both files are optional and gitignored.

| Variable | Default | Applies to |
| --- | --- | --- |
| `VOIDOCK_DRIVER` | `sandbox` on Vercel, else `docker` | both |
| `MANAGEMENT_APP_PORT` | `8080` (`80` on Vercel via `PORT`) | both |
| `WORKLOAD_PORT` | `80` | both — port the workload listens on *inside its container* |
| `REVERSE_PROXY_HOST` | `localhost` | `docker` |
| `SANDBOX_PORT` | `8000` | `sandbox` — port the sandbox publishes *to the internet* |
| `SANDBOX_TIMEOUT_MS` | `1800000` (30 min) | `sandbox` |
| `SANDBOX_VCPUS` | `2` | `sandbox` |

> **`WORKLOAD_PORT` is for HTTP only.** It fixes images that serve HTTP on a
> non-80 port (a Node app on 3000, Django on 8000, ...). Databases, caches, and
> queues (Postgres, Redis, Kafka, RabbitMQ, ...) don't speak HTTP at all, so this
> won't help them — they need `port` on `POST /container` instead, a raw TCP
> passthrough available on the `docker` driver only. Some of those images also
> refuse to boot at all without a credential passed via `env` — see
> [Running Non-HTTP Workloads](#running-non-http-workloads)
> and [API Reference](#post-container).

## API Reference

Base URL: `http://localhost:8080` (self-hosted) or your Vercel deployment.

#### `GET /health`
```json
{ "status": "Management App is up and Running.", "driver": "docker" }
```

#### `POST /container`
```bash
curl -X POST /container -H "Content-Type: application/json" \
  -d '{"image":"nginx","tag":"alpine"}'
```
```json
{ "status": "success", "data": { "containerName": "nervous_ritchie", "domain": "nervous_ritchie.localhost", "url": "http://nervous_ritchie.localhost", "tcpAddress": null } }
```
Accepts any Docker Hub image, a specific tag (`nginx:alpine`), or a full registry ref (`ghcr.io/user/repo:latest`).

**Non-HTTP images** (Postgres, Redis, Kafka, ...) — `docker` driver only — pass `port`, the container-internal port to publish directly, bypassing the HTTP proxy entirely:
```bash
curl -X POST /container -H "Content-Type: application/json" \
  -d '{"image":"redis","tag":"alpine","port":6379}'
```
```json
{ "status": "success", "data": { "containerName": "jovial_kare", "domain": "jovial_kare.localhost", "url": "http://jovial_kare.localhost", "tcpAddress": "localhost:55266" } }
```
Connect with the service's own client (`redis-cli -h localhost -p 55266`), not a browser — `tcpAddress` is a raw TCP passthrough, not HTTP. The assigned port is **not stable across a stop/restart** (Docker re-randomizes it); always read the current one from `GET /list` rather than caching it. Unsupported on the `sandbox` driver, which only exposes HTTP(S).

**`env`** — a flat object of string values, set as environment variables inside the container. Both drivers support this. Some images require it just to boot — see [Running Non-HTTP Workloads](#running-non-http-workloads):
```bash
curl -X POST /container -H "Content-Type: application/json" \
  -d '{"image":"postgres","tag":"16","port":5432,"env":{"POSTGRES_PASSWORD":"changeme"}}'
```
Values are applied once at container creation and aren't returned in any response — save them yourself if you'll need them again. On the `sandbox` driver, `env` only takes effect on the initial `create()`; if the container has to be recreated from scratch after a lost sandbox (an edge case — see [Capabilities](#capabilities)), a fresh one won't have it.

#### `GET /list`
Returns every workload with `id`, `name`, `image`, `state` (`running` / `starting` / `exited` / `dead`), `status`, `domain`, `url`, `tcpAddress` (`null` unless created with `port`).

#### `POST /container/:id/stop` · `POST /container/:id/start` · `POST /container/:id/restart`
Lifecycle control. No body.

#### `DELETE /container/:id`
Permanently removes the workload.

#### `GET /container/:id/logs?tail=100`
```json
{ "status": "success", "data": "... container output ..." }
```

## Project Structure

```
VoiDock/
├── index.html          # Web dashboard (dark mode UI)
├── server.js           # Express API & reverse proxy server
├── docker.js           # Docker orchestration layer (dockerode)
├── drivers/
│   ├── index.js        # Driver selection (VOIDOCK_DRIVER)
│   ├── docker.js        # Docker daemon driver
│   ├── sandbox.js       # Vercel Sandbox driver
│   └── README.md        # Driver contract
├── docker-compose.yml  # Self-hosted deployment
├── Dockerfile.vercel   # Vercel deployment (sandbox driver)
├── package.json
└── README.md
```

## Use Cases

- **Multi-tenant SaaS** — one container per customer, isolated by construction, routed by name
- **Ephemeral CI/CD environments** — spin up postgres/redis/etc. per test run, delete when done
- **Untrusted code execution** — sandbox student/user-submitted code without touching the host
- **Feature-branch previews** — a live URL per PR, torn down on merge
- **Sales demos & staging** — a fresh, isolated environment per prospect, expiring on its own

```bash
# Per-customer isolation
curl -X POST /container -d '{"image":"node:20-alpine","tag":"latest"}'
# → customer-a.yourapp.com

# CI: ephemeral test database (non-HTTP, so `port` is required; postgres also
# needs `env` just to boot — see API Reference and Running Non-HTTP Workloads)
RESP=$(curl -s -X POST /container -d '{"image":"postgres","tag":"16","port":5432,"env":{"POSTGRES_PASSWORD":"ci-test"}}')
CONTAINER=$(echo "$RESP" | jq -r '.data.containerName')
DB_ADDR=$(echo "$RESP" | jq -r '.data.tcpAddress')   # e.g. localhost:55432
npm test   # point your test config at $DB_ADDR, user postgres / password ci-test
curl -X DELETE "/container/$CONTAINER"
```

## Capabilities

What's actually possible today, and what isn't — read this before building around VoiDock.

### Possible

- Launch any Docker Hub / private-registry / custom-built image on demand, on either driver
- Get a public URL automatically for anything serving plain HTTP (port 80, or `WORKLOAD_PORT` if it's different)
- Reach non-HTTP images (Redis, Postgres, ...) via a raw TCP address — `docker` driver only, see [Running Non-HTTP Workloads](#running-non-http-workloads)
- Pass env vars at launch (`env`) — needed for images that require credentials just to boot
- Full lifecycle control — start, stop, restart, delete, tail logs — on both drivers
- Multi-tenant isolation by construction — one container/sandbox per workload, nothing shared unless you add it yourself
- Run self-hosted on any machine with Docker, or serverless on Vercel, from the same codebase

### Not possible (yet)

- **No built-in authentication on the management API** — anyone who can reach `MANAGEMENT_APP_PORT` can create, stop, delete, or read the logs of any workload. Put it behind a VPN, firewall, or your own auth proxy — don't expose it to the open internet as-is.
- **No persistent storage or volumes** — workloads are disposable; deleting a container deletes its data. Back anything worth keeping with an external volume, database, or object store.
- **No multi-container compositions** — one image per `POST /container` call; there's no docker-compose-style "these services are one unit."
- **Raw TCP is `docker`-driver-only** — on `sandbox` (Vercel), a non-HTTP image runs but is permanently unreachable from outside its own sandbox; there is no workaround short of switching drivers.
- **TCP ports aren't stable across a restart** — Docker re-randomizes the published host port on every start; always re-read `tcpAddress` from `GET /list`, never cache it.
- **`env` isn't retained through a full sandbox recreate** — the rare case where a `sandbox` workload's container is lost and rebuilt from scratch (see the driver's contract in [drivers/README.md](drivers/README.md)); normal stop/start is unaffected.
- **No per-workload resource limits** — CPU/memory caps aren't configurable via the API yet.
- **No multi-node clustering** — `docker` is one Docker host; `sandbox` is bounded by your Vercel plan's concurrency limits.
- **`sandbox` workloads expire** — hard lifetime cap (45 min Hobby / 24 h Pro) and slow cold creates (30-60s+); see the Vercel trade-offs above.
- **Run behind TLS in production** — VoiDock's own HTTP reverse proxy is plain HTTP; put a load balancer or CDN in front for anything public.

## Roadmap

- [ ] Container resource limits (CPU, memory)
- [ ] WebSocket log streaming
- [ ] Container metrics (CPU, memory, network)
- [ ] Private registry authentication
- [ ] Volume mounting
- [ ] Authentication on the management API itself

## Contributing

This is a personal/small-team project. For bugs or feature ideas, open an issue.

## License

ISC
