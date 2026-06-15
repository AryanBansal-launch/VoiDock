# VoiDock 🐳

**On-demand Docker container orchestration with a beautiful management UI.**

VoiDock is a lightweight, self-hosted platform for spinning up isolated Docker containers dynamically. Deploy, manage, and route traffic to containers via a simple HTTP API or intuitive web dashboard—perfect for multi-tenant apps, sandbox environments, and dynamic workloads.

## What Does It Do?

VoiDock lets you:
- **Launch containers on demand** via API or UI (no docker-compose needed)
- **Instantly route traffic** to containers by domain (e.g., `my-app.localhost`)
- **Manage container lifecycle** — start, stop, restart, delete, view logs
- **Pull images automatically** — if an image isn't local, VoiDock fetches it
- **Clean up automatically** — containers self-destruct when stopped
- **See everything at a glance** — beautiful dark-mode dashboard with live updates

## When Should You Use VoiDock?

### 🎯 Multi-Tenant SaaS Platforms
Spin up an isolated application instance per customer. Each gets its own container, its own domain, complete isolation, and automatic cleanup.

**Example:**
```bash
# Customer A gets their own nginx instance
POST /container {"image": "nginx", "tag": "latest"}
# → Access at customer-a.yourapp.com

# Customer B gets a separate one
POST /container {"image": "nginx", "tag": "latest"}
# → Access at customer-b.yourapp.com
```

### 🧪 Dynamic Test Environments
Create ephemeral containers for each CI/CD test run. No lingering state. Each test gets a fresh, isolated database/service.

**Example in CI/CD:**
```bash
# Spin up a postgres container for this test run
curl -X POST http://voidock:8080/container \
  -H "Content-Type: application/json" \
  -d '{"image":"postgres","tag":"16"}'

# Run your tests against it
# Container auto-cleans when test finishes
```

### 📦 Sandbox & Untrusted Code Execution
Let users run arbitrary code safely in isolated containers. VoiDock handles container isolation and cleanup.

**Example:**
- Educational platforms: students submit code → spun into a Python container
- Code execution APIs: users post code → you run it in an isolated Node container
- Code playgrounds: dynamic execution environments

### 🔧 Microservices in Development
Quick iteration without managing `docker-compose.yml` files. Deploy any service (postgres, redis, nginx, etc.) with one API call.

### 🎬 Live Demos & Staging
Create temporary demo environments that expire after the demo. Perfect for:
- Sales demos (customer gets isolated demo app)
- Conference talks (spin up services on the fly)
- Product showcases (clean slate every time)

### 👥 Developer Platforms
Build internal tooling where developers can provision their own isolated environments:
- Database instances per developer
- API testing environments
- Service orchestration without Kubernetes complexity

### 🏫 Educational & Training Platforms
- Students deploy their own applications
- Instructors run labs in isolated containers
- Auto-cleanup after sessions end

## Real-World Scenarios

### Scenario 1: Code Playground SaaS (LeetCode-Style Platform)

**The Problem:** You're building an online code execution platform. Users submit Python/JavaScript/Go code, and you need to run it safely without it affecting other users.

**How VoiDock Solves It:**

```javascript
// User submits code via web form
app.post('/execute-code', async (req, res) => {
  const { language, code, userId } = req.body;

  // Spin up an isolated container
  const container = await fetch('http://voidock:8080/container', {
    method: 'POST',
    body: JSON.stringify({
      image: `${language}-runtime`,  // python:3.11, node:20, golang:latest
      tag: 'latest'
    })
  }).then(r => r.json());

  // Run user code inside (via your execution service)
  const output = await executeInContainer(container.id, code, {
    timeout: 5000,  // Kill after 5 seconds
    memory: '256m'
  });

  // Container auto-cleans when stopped
  res.json({ output, executionId: container.id });
});
```

**Benefits:**
- ✅ User code is **completely isolated** — can't affect your system
- ✅ **Auto-timeout** — malicious infinite loops die after 5s
- ✅ **No state leakage** — fresh container each execution
- ✅ **Scales horizontally** — spin up hundreds of containers as needed

---

### Scenario 2: Multi-Tenant Database Backups (Internal Tool)

**The Problem:** You have 50 SaaS customers. Each month, you need to export their databases, transform data, generate reports—all in separate isolated environments.

**How VoiDock Solves It:**

```bash
#!/bin/bash
# Monthly backup job

CUSTOMERS=(acme-corp startup-xyz enterprise-ltd)

for customer in "${CUSTOMERS[@]}"; do
  # Spin up a postgres container just for this customer's export
  CONTAINER=$(curl -s -X POST http://voidock:8080/container \
    -d '{"image":"postgres","tag":"16"}' | jq -r '.data.id')

  # Restore their latest backup into this container
  psql postgresql://localhost/$CONTAINER < backups/$customer/latest.sql

  # Run transformations & report generation (isolated to this customer)
  python3 transform_and_report.py $CONTAINER $customer

  # Container auto-cleans — no leftover data
  curl -X DELETE http://voidock:8080/container/$CONTAINER
done
```

**Benefits:**
- ✅ **Zero cross-customer contamination** — each gets a fresh DB
- ✅ **Parallelizable** — process all 50 customers at once
- ✅ **No cleanup overhead** — containers auto-remove
- ✅ **Easy debugging** — logs captured for each customer

---

### Scenario 3: CI/CD Test Matrix (Dynamic Test Environments)

**The Problem:** Your test suite needs postgres, redis, and elasticsearch. Instead of running everything in one container, spin up isolated test environments.

**How VoiDock Solves It:**

```yaml
# .github/workflows/test.yml
name: Test

on: [push]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Spin up test services
        run: |
          # Each service gets its own isolated container
          curl -X POST http://voidock:8080/container \
            -d '{"image":"postgres","tag":"16"}' > /tmp/db.json

          curl -X POST http://voidock:8080/container \
            -d '{"image":"redis","tag":"7"}' > /tmp/cache.json

          curl -X POST http://voidock:8080/container \
            -d '{"image":"elasticsearch","tag":"8"}' > /tmp/search.json

      - name: Run tests
        env:
          DB_HOST: postgres.${{ env.REVERSE_PROXY_HOST }}
          CACHE_HOST: redis.${{ env.REVERSE_PROXY_HOST }}
          SEARCH_HOST: elasticsearch.${{ env.REVERSE_PROXY_HOST }}
        run: npm test

      # No cleanup needed — containers auto-remove after test
```

**Benefits:**
- ✅ **No Docker-Compose complexity** — one API call per service
- ✅ **Parallel test runs** — spin up 10 test environments simultaneously
- ✅ **Zero state pollution** — fresh services each run
- ✅ **Faster CI** — no waiting for service startup across runs

---

### Scenario 4: SaaS Customer Demo Environments

**The Problem:** Your sales team demos your app to prospects. Each demo should be isolated, fresh, and only live for 1 hour.

**How VoiDock Solves It:**

```javascript
// Triggered when sales reps book a demo
app.post('/create-demo-env', async (req, res) => {
  const { prospectName, durationMinutes } = req.body;

  // Spin up a demo app container
  const demo = await fetch('http://voidock:8080/container', {
    method: 'POST',
    body: JSON.stringify({
      image: 'your-saas-app:demo',
      tag: 'latest'
    })
  }).then(r => r.json());

  const demoUrl = demo.data.url;  // e.g., youthful_darwin.yourdomain.com

  // Email the prospect a unique demo link
  sendEmail(prospect.email, {
    subject: 'Your 1-Hour SaaS Demo',
    body: `Access your demo here: ${demoUrl}`,
    expiresIn: durationMinutes
  });

  // Auto-stop after 1 hour (optional scheduled job)
  scheduleStop(demo.data.id, durationMinutes * 60);

  res.json({ demoUrl, expiresIn: durationMinutes });
});
```

**Benefits:**
- ✅ **Fresh start each time** — no leftover data from previous demos
- ✅ **Automatic expiration** — demos disappear after 1 hour
- ✅ **Scale to unlimited demos** — no demo environment per sales rep needed
- ✅ **Easy cleanup** — no manual environment teardown

---

### Scenario 5: Temporary Staging for Feature Branches

**The Problem:** Every feature branch needs a staging environment. But you don't want 20+ long-lived staging servers running.

**How VoiDock Solves It:**

```bash
# .github/workflows/feature-branch-staging.yml

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  staging:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Build feature branch image
        run: docker build -t my-app:pr-${{ github.event.number }} .

      - name: Push to registry
        run: docker push my-app:pr-${{ github.event.number }}

      - name: Spin up staging environment
        run: |
          curl -X POST http://voidock:8080/container \
            -d '{"image":"my-app","tag":"pr-${{ github.event.number }}"}'

      - name: Comment PR with staging URL
        uses: actions/github-script@v6
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: '🚀 Staging: http://pr-${{ github.event.number }}.staging.myapp.com'
            })

  cleanup:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - name: Remove staging environment
        run: |
          # Delete container when PR is closed
          curl -X DELETE http://voidock:8080/container/pr-${{ github.event.number }}
```

**Benefits:**
- ✅ **Auto-provisioned** — every PR gets a staging URL automatically
- ✅ **Auto-cleaned** — removed when PR closes
- ✅ **No resource waste** — not keeping staging servers for closed PRs
- ✅ **Reviewers can test** — click staging URL to see the feature live

---

## How It Works

```
┌─────────────────────┐
│   VoiDock UI/API    │
│   (Port 8080)       │
└──────────┬──────────┘
           │
           │ POST /container
           │ {"image": "nginx"}
           ↓
┌─────────────────────┐
│  Docker Daemon      │─→ Pulls image if needed
│  (socket)           │─→ Creates container on voidock-network
└──────────┬──────────┘
           │
    ┌──────┴─────────┐
    ↓                ↓
┌─────────┐     ┌──────────┐
│Container│     │ Reverse  │
│ (nginx) │←────│ Proxy    │ ← HTTP traffic to
│ :80     │     │(Port 80) │   nginx.localhost
└─────────┘     └──────────┘
```

**Flow:**
1. You deploy: `POST /container {"image": "nginx", "tag": "latest"}`
2. VoiDock pulls the image (if needed), creates container on an internal Docker network
3. Container is assigned a random name (e.g., `nervous_ritchie`)
4. Reverse proxy is configured: `nervous_ritchie.localhost → 172.18.0.2:80` (container's internal IP)
5. You access at: `http://nervous_ritchie.localhost`
6. When you stop/delete the container, it auto-cleans

## Features

- ✅ **Web Dashboard** — Deploy, monitor, control containers with a sleek UI
- ✅ **HTTP REST API** — Programmatic container management
- ✅ **Automatic Image Pulling** — No pre-download needed
- ✅ **Custom Images** — Deploy any Docker image (DockerHub, registries, custom builds)
- ✅ **Built-in Reverse Proxy** — One-click access via domain
- ✅ **Container Lifecycle Control** — Start, stop, restart, delete
- ✅ **Logs Viewer** — See container output in real-time
- ✅ **Image Suggestions** — Searchable input with popular images (nginx, postgres, redis, node, python, etc.)
- ✅ **Health Status** — Real-time API status indicator
- ✅ **Auto-Cleanup** — Containers remove themselves when stopped
- ✅ **Dark Mode** — Beautiful, modern UI built for the terminal generation

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [Docker](https://www.docker.com/) daemon (local or remote)
- Docker socket access: `/var/run/docker.sock` (for Docker-on-Docker, mount appropriately)

## Installation

```bash
git clone https://github.com/AryanBansal-launch/VoiDock.git
cd VoiDock
npm install
```

## Configuration

Environment variables (set in `.env` or your deployment):

| Variable               | Default     | Description                                          |
| ---------------------- | ----------- | ---------------------------------------------------- |
| `MANAGEMENT_APP_PORT`  | `8080`      | Port the management API listens on.                  |
| `REVERSE_PROXY_HOST`   | `localhost` | Base host for container domains (e.g., `myapp.com`). |

**Example `.env`:**
```env
MANAGEMENT_APP_PORT=8080
REVERSE_PROXY_HOST=demo.mycompany.com
```

## Running

### Locally (Node + Docker)

```bash
npm start
```

You'll see:
```
Management API is running on PORT : 8080
Reverse proxy is running on port 80
```

Visit: **http://localhost:8080** (UI) or **http://localhost** (reverse proxy)

### With Docker Compose (Recommended)

```bash
docker compose up --build
```

This:
- Builds VoiDock in a container
- Mounts the Docker socket for container orchestration
- Exposes port 8080 (management API) and port 80 (reverse proxy)
- Creates the `voidock-network` for inter-container communication

## API Reference

### Management API (Port 8080)

#### `GET /health`
Health check endpoint.

```bash
curl http://localhost:8080/health
```

Response:
```json
{ "status": "Management App is up and Running." }
```

#### `GET /`
Serves the VoiDock dashboard UI.

#### `POST /container`
Create and start a container from any Docker image.

**Request:**
```json
{
  "image": "nginx",
  "tag": "latest"
}
```

**Supported Image Sources:**
- **DockerHub** (default): `nginx`, `postgres`, `redis`, `node`, `python`, etc.
- **Specific versions**: `postgres:16`, `node:20-alpine`
- **Private registries**: `myregistry.azurecr.io/my-app`
- **GitHub Container Registry**: `ghcr.io/user/repo:latest`
- **Custom builds**: `my-custom-image:v1.0`

**Examples:**

Public image:
```bash
curl -X POST http://localhost:8080/container \
  -H "Content-Type: application/json" \
  -d '{"image":"postgres","tag":"16"}'
```

Custom/private image:
```bash
curl -X POST http://localhost:8080/container \
  -H "Content-Type: application/json" \
  -d '{"image":"ghcr.io/user/my-app","tag":"v1.0"}'
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "containerName": "nervous_ritchie",
    "domain": "nervous_ritchie.localhost",
    "url": "http://nervous_ritchie.localhost"
  }
}
```

#### `GET /list`
List all containers (running and stopped).

```bash
curl http://localhost:8080/list
```

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": "abc123...",
      "name": "nervous_ritchie",
      "image": "nginx:latest",
      "state": "running",
      "status": "Up 2 minutes",
      "domain": "nervous_ritchie.localhost",
      "url": "http://nervous_ritchie.localhost"
    }
  ]
}
```

#### `POST /container/:id/stop`
Stop a running container.

```bash
curl -X POST http://localhost:8080/container/abc123/stop
```

#### `POST /container/:id/start`
Start a stopped container.

```bash
curl -X POST http://localhost:8080/container/abc123/start
```

#### `POST /container/:id/restart`
Restart a container.

```bash
curl -X POST http://localhost:8080/container/abc123/restart
```

#### `DELETE /container/:id`
Delete a container permanently.

```bash
curl -X DELETE http://localhost:8080/container/abc123
```

#### `GET /container/:id/logs`
Get container logs (last 100 lines by default).

```bash
curl http://localhost:8080/container/abc123/logs?tail=50
```

**Response:**
```json
{
  "status": "success",
  "data": "... container output ..."
}
```

## Project Structure

```
VoiDock/
├── index.html          # Web dashboard (dark mode UI)
├── server.js           # Express API & reverse proxy server
├── docker.js           # Docker orchestration layer
├── docker-compose.yml  # Docker Compose configuration
├── package.json
└── README.md
```

## Architecture

**Two servers in one process:**

1. **Management API (Express, port 8080)**
   - REST endpoints for container lifecycle
   - Serves the dashboard UI
   - Health checks

2. **Reverse Proxy (http-proxy, port 80)**
   - Routes incoming requests by hostname
   - Looks up container IP on the internal network
   - Forwards traffic to the correct container

**Networking:**

- All launched containers run on the `voidock-network` (isolated Docker bridge network)
- Containers can reach each other by name (e.g., `curl http://other-container:80`)
- The reverse proxy routes external traffic to containers by hostname
- Containers cannot reach the host unless explicitly configured

## Use Cases & Examples

### Example 1: SaaS Isolation (Per-Customer Sandbox)

```bash
# Customer A signs up
curl -X POST http://voidock:8080/container \
  -d '{"image":"node:20-alpine","tag":"latest"}'
# → customer_a.myapp.com points to their Node instance

# Customer B signs up
curl -X POST http://voidock:8080/container \
  -d '{"image":"node:20-alpine","tag":"latest"}'
# → customer_b.myapp.com points to their Node instance

# Each customer has isolated code, isolated state, zero leakage
```

### Example 2: CI/CD Test Isolation

```bash
#!/bin/bash
# .github/workflows/test.yml

# Spin up a Postgres container for this test run
CONTAINER=$(curl -s -X POST http://voidock:8080/container \
  -d '{"image":"postgres","tag":"16"}' | jq -r '.data.id')

# Run tests against postgres container
npm test

# Container auto-cleans; no state from previous test runs
```

### Example 3: Code Execution Sandbox

```python
# FastAPI endpoint: user submits Python code
@app.post("/execute")
def execute_code(code: str):
    # Spin up a Python container
    resp = requests.post("http://voidock:8080/container", 
        json={"image": "python", "tag": "3.11"})
    
    container_id = resp.json()["data"]["id"]
    container_url = resp.json()["data"]["url"]
    
    # User's code runs safely inside
    output = execute_in_container(container_id, code)
    
    # Container cleaned up automatically
    return {"output": output}
```

## Roadmap

- [ ] Container resource limits (CPU, memory)
- [ ] WebSocket logs stream (real-time log viewer)
- [ ] Container metrics (CPU, memory, network)
- [ ] Webhook notifications (on container events)
- [ ] Image registry authentication (private images)
- [ ] Volume mounting
- [ ] Environment variable injection at launch time
- [ ] Rate limiting & quota management
- [ ] Multi-node clustering

## Limitations & Considerations

- **Single Machine Only** — VoiDock is designed for one Docker host. For multi-node, consider Kubernetes.
- **Storage** — Containers auto-cleanup, so persistent data must be external (volumes, databases, object storage).
- **Security** — Run behind a proper reverse proxy (nginx) in production with authentication/TLS.
- **Port 80** — The reverse proxy runs on port 80. In production, use a load balancer on port 80/443.

## Deployment

### On Linux VM / Dedicated Server

```bash
# Clone & run with Docker Compose
git clone https://github.com/AryanBansal-launch/VoiDock.git
cd VoiDock
docker compose up -d

# Set a domain for REVERSE_PROXY_HOST
REVERSE_PROXY_HOST=demo.mycompany.com docker compose up
```

### On Cloud (AWS, GCP, DigitalOcean)

Run VoiDock in a container with Docker-in-Docker:

```yaml
# docker-compose.yml (production)
version: '3.8'
services:
  voidock:
    build: .
    ports:
      - "8080:8080"
      - "80:80"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      MANAGEMENT_APP_PORT: 8080
      REVERSE_PROXY_HOST: ${DOMAIN:-localhost}
    restart: always
```

## Contributing

This is a personal/small-team project. For bugs or feature ideas, open an issue!

## License

ISC
