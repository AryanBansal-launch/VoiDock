import Docker from 'dockerode';

const docker = new Docker();


export function pullImage(image, tag) {
    const ref = `${image}:${tag}`;
    return new Promise((resolve, reject) => {
        docker.pull(ref, (err, stream) => {
            if (err) {
                return reject(err);
            }
            docker.modem.followProgress(stream, (progressErr) => {
                if (progressErr) {
                    return reject(progressErr);
                }
                resolve(true);
            });
        });
    });
}

export async function imageExists(image, tag) {
    const ref = `${image}:${tag}`;
    const images = await docker.listImages();
    return images.some((img) => (img.RepoTags || []).includes(ref));
}

export async function ensureImage(image, tag) {
    if (!(await imageExists(image, tag))) {
        await pullImage(image, tag);
    }
}

export async function ensureNetwork(name = 'voidock-network') {
    try {
        const network = docker.getNetwork(name);
        await network.inspect();
        return network;
    } catch (err) {
        if (err.statusCode === 404) {
            return docker.createNetwork({
                Name: name,
                Driver: 'bridge',
            });
        }
        throw err;
    }
}

// The port the workload listens on *inside* the container. The reverse proxy
// always connects here, so an image that binds a different port (most non-nginx
// HTTP servers do — Node apps on 3000, Django on 8000, Grafana on 3000, ...) needs
// this set to match. Protocols other than HTTP (Postgres, Redis, Kafka, ...) can
// never be reached through the proxy regardless of this setting.
export const WORKLOAD_PORT = Number(process.env.WORKLOAD_PORT ?? 80);

// `tcpPort`, when given, publishes that container-internal port directly onto a
// host port (Docker assigns a free one) instead of routing it through the HTTP
// reverse proxy. This is how non-HTTP workloads — Redis, Postgres, anything that
// doesn't speak HTTP — become reachable at all: the proxy can only forward HTTP,
// but a published port is a raw TCP passthrough, so any client that speaks the
// service's real protocol can connect directly.
//
// Caveat verified against plain `docker` (not just this code): with HostPort: ''
// Docker re-randomizes the host port on every start, not just at creation — a
// stop/start or restart changes it. Callers must re-fetch /list for the current
// tcpAddress rather than caching the one returned by create().
export async function runContainer(image, tag, { tcpPort, env } = {}) {
    await ensureNetwork();

    const exposedPorts = { [`${WORKLOAD_PORT}/tcp`]: {} };
    const portBindings = {};

    if (tcpPort) {
        exposedPorts[`${tcpPort}/tcp`] = {};
        // Empty HostPort asks Docker to pick any free port rather than us managing
        // a range and racing other containers for it.
        portBindings[`${tcpPort}/tcp`] = [{ HostPort: '' }];
    }

    const container = await docker.createContainer({
        Image: `${image}:${tag}`,
        ExposedPorts: exposedPorts,
        // Some images (Postgres, MySQL, ...) refuse to boot at all without a
        // credential passed this way — verified live, not assumed: bare `postgres`
        // and `mysql` both exit immediately demanding POSTGRES_PASSWORD /
        // MYSQL_ROOT_PASSWORD respectively.
        ...(env && Object.keys(env).length
            ? { Env: Object.entries(env).map(([k, v]) => `${k}=${v}`) }
            : {}),
        HostConfig: {
            // Not AutoRemove: that destroys the container the instant it stops,
            // which made the dashboard's Start button (and this TCP port binding)
            // permanently unusable — `stop` left nothing for `start` to resume.
            // Deletion is explicit: the Delete action calls removeContainer().
            ...(tcpPort ? { PortBindings: portBindings } : {}),
        },
        NetworkingConfig: {
            EndpointsConfig: {
                'voidock-network': {},
            },
        },
    });

    await container.start();

    // Give the container a moment to initialize and start listening
    await new Promise((resolve) => setTimeout(resolve, 1000));

    return container.inspect();
}

// Reads back the host port Docker assigned for a published container port, or
// null if that port was never published (or the container hasn't started).
export function getPublishedHostPort(inspect, containerPort) {
    const binding = inspect.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
    return binding?.[0]?.HostPort ? Number(binding[0].HostPort) : null;
}

export async function listContainers(all = true) {
    const containers = await docker.listContainers({
        all,
    });

    return containers.map((container) => ({
        id: container.Id,
        name: container.Names?.[0]?.replace('/', ''),
        image: container.Image,
        state: container.State,
        status: container.Status,
        // Raw port list from the Docker API — WORKLOAD_PORT is always exposed but
        // never published, so any entry with a PublicPort is unambiguously a
        // container created with a tcpPort (see runContainer).
        ports: container.Ports,
    }));
}

export async function stopContainer(containerId) {
    const container = docker.getContainer(containerId);
    await container.stop({ t: 10 });
    return container.inspect();
}

export async function startContainer(containerId) {
    const container = docker.getContainer(containerId);
    await container.start();
    return container.inspect();
}

export async function restartContainer(containerId) {
    const container = docker.getContainer(containerId);
    await container.restart({ t: 10 });
    return container.inspect();
}

export async function removeContainer(containerId) {
    const container = docker.getContainer(containerId);
    await container.remove({ force: true });
    return { success: true };
}

// Docker multiplexes stdout/stderr into frames — an 8-byte header (stream type +
// big-endian payload length) before each chunk — unless the container has a TTY
// attached. Stripping only applies to the non-TTY case; a naive .toString() over
// multiplexed output leaks header bytes as stray leading characters per line.
function demuxLogs(buffer) {
    let out = '';
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        const size = buffer.readUInt32BE(offset + 4);
        const start = offset + 8;
        const end = Math.min(start + size, buffer.length);
        out += buffer.toString('utf8', start, end);
        offset = end;
    }
    return out;
}

export async function getContainerLogs(containerId, tail = 100) {
    const container = docker.getContainer(containerId);
    const [info, raw] = await Promise.all([
        container.inspect(),
        container.logs({ stdout: true, stderr: true, tail }),
    ]);

    return info.Config?.Tty ? raw.toString('utf8') : demuxLogs(raw);
}

export async function getContainerIp(containerId, network = 'voidock-network') {
    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    return inspect.NetworkSettings.Networks[network]?.IPAddress ?? null;
}

export default docker;
