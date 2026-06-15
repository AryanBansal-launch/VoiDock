# VoiDock

A lightweight Docker container management API. VoiDock exposes a small HTTP
"management" service that lets you spin up containers on demand and hands back a
routable domain for each one — the building block for an on-the-fly reverse
proxy in front of your containers.

## How it works

- A management API (Express) listens for requests to create containers.
- On request, VoiDock ensures the requested image is available locally (pulling
  it if needed), then creates and starts a container.
- Containers are started with `AutoRemove`, so they clean themselves up when
  they stop.
- Each container is mapped to a domain of the form
  `<containerName>.<REVERSE_PROXY_HOST>`.

## Requirements

- [Node.js](https://nodejs.org/) 18+
- A running [Docker](https://www.docker.com/) daemon reachable from the host
  (VoiDock talks to it via the local Docker socket through
  [`dockerode`](https://github.com/apocas/dockerode)).

## Installation

```bash
git clone https://github.com/AryanBansal-launch/VoiDock.git
cd VoiDock
npm install
```

## Configuration

Configuration is read from environment variables (a local `.env` is ignored by
git):

| Variable               | Default     | Description                                          |
| ---------------------- | ----------- | ---------------------------------------------------- |
| `MANAGEMENT_APP_PORT`  | `8080`      | Port the management API listens on.                  |
| `REVERSE_PROXY_HOST`   | `localhost` | Base host used to build per-container domain names.  |

## Running

```bash
npm start
```

You should see:

```
Management API is running on PORT : 8080
```

## API

### `GET /`

Health check.

```bash
curl http://localhost:8080/
```

```json
{ "status": "Management App is up and Running." }
```

### `POST /container`

Create and start a container from an image. Pulls the image first if it isn't
already present locally.

**Request body**

```json
{
  "image": "nginx",
  "tag": "latest"
}
```

**Example**

```bash
curl -X POST http://localhost:8080/container \
  -H "Content-Type: application/json" \
  -d '{"image":"nginx","tag":"latest"}'
```

**Success response**

```json
{
  "status": "success",
  "data": {
    "containerName": "/quirky_swartz",
    "domain": "/quirky_swartz.localhost"
  }
}
```

**Error responses**

- `400` — `image` or `tag` missing from the request body.
- `500` — Docker failed to pull the image or start the container.

## Project structure

```
VoiDock/
├── server.js     # Express management API and route handlers
├── docker.js     # Docker helpers (pull, existence check, run container)
└── package.json
```

## Roadmap / TODO

- Connect started containers to the host network so a reverse proxy can route
  traffic to them.

## License

ISC
