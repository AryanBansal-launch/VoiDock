# VoiDock drivers

A driver is the engine that actually runs a tenant's workload. Every driver exports
the same shape, so `server.js` and the dashboard never learn which one is active.

```
name        string    // driver id, surfaced on /health
needsProxy  boolean   // true if VoiDock must run its own reverse proxy on :80

create({ image, tag, port, env })-> Record   // `port`: docker driver only, see below
list()                      -> Record[]
stop(id)                    -> void
start(id)                   -> void
restart(id)                 -> void
remove(id)                  -> void
logs(id, tail)              -> string
resolveTarget(hostLabel)    -> string | null   // proxy drivers only
```

A `Record` is what the dashboard renders, and is identical across drivers:

```
{ id, name, image, state, status, domain, url, tcpAddress }
```

`state` is Docker's vocabulary (`running`, `exited`, `created`, `dead`) plus one
addition, `starting` — sandbox-only, covering the window where the microVM has
booted but the workload is still installing Docker / pulling its image / not yet
answering on its port. `url`/`domain` must be withheld (`null`/a placeholder
string) for anything that isn't actually `running`; [index.html](../index.html)
groups cards into four buckets by this field and disables actions accordingly.

Both drivers always proxy to `WORKLOAD_PORT` (default `80`) on the container's
*internal* side — an image serving HTTP on a different port needs that env var
set to match. Neither driver's HTTP routing speaks anything but HTTP, so a
non-HTTP image (Postgres, Redis, Kafka, ...) will `create()` successfully but
can never have a working `url` through it — that's a hard ceiling of what a
"container gets a URL" model can express, not a bug to fix per-driver.

`tcpAddress` is the escape hatch: the `docker` driver can publish a container's
port directly onto the host (a raw TCP passthrough, Docker doing the forwarding
natively — no proxy code involved) when `port` is passed to `create()`. It's
`null` whenever `port` wasn't given, and always `null` on the `sandbox` driver,
which rejects a `port` argument outright — Vercel Sandbox only exposes ports as
an HTTPS reverse proxy, so there's no equivalent to offer. The host port Docker
assigns is **not stable across a restart** — callers should always re-derive it
from `list()`, never cache a `tcpAddress` past the `create()` response.

`env` is a flat `{KEY: "value"}` object applied as container env vars. Verified
live, not assumed: bare `postgres` and `mysql` exit immediately without a
credential passed this way, so this exists to make those launchable at all, not
just to be thorough. Both drivers apply it at container creation only — a plain
`docker start`/`restart` on the same container reuses the Env it was created
with, so nothing needs to flow through `start()`/`restart()`. It's only lost if
a container has to be recreated from scratch, which on `sandbox` can happen if
the workload container itself goes missing on resume (see `reviveWorkload()` in
[sandbox.js](sandbox.js)) — deliberately not persisted into sandbox tags to
avoid writing secrets there.

## docker

Talks to a Docker daemon over `/var/run/docker.sock`. Containers join the
`voidock-network` bridge and VoiDock proxies `<name>.<host>` to the container's
`WORKLOAD_PORT`. Requires a real host with the socket mounted — see
[docker-compose.yml](../docker-compose.yml). Containers are *not* `AutoRemove`:
that setting used to destroy a container the instant `stop()` touched it, which
made `start()` 404 unconditionally — deletion now only happens through `remove()`.

## sandbox

Each tenant workload becomes one [Vercel Sandbox](https://vercel.com/docs/sandbox):
a Firecracker microVM running its own `dockerd`, with the workload's
`WORKLOAD_PORT` published on `SANDBOX_PORT` (`docker run -p SANDBOX_PORT:WORKLOAD_PORT`).
`sandbox.domain(SANDBOX_PORT)` hands back a public `*.vercel.run` URL, so
`needsProxy` is `false` and nothing has to bind port 80. `create()`/`start()`/
`restart()` block until something answers on `WORKLOAD_PORT` before returning —
`docker run -d` only guarantees the container exists, not that it's listening yet.

Selection happens in [index.js](index.js): `VOIDOCK_DRIVER=docker|sandbox`,
defaulting to `sandbox` when `VERCEL` is set and `docker` otherwise.
