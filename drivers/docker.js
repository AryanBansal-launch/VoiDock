import {
    ensureImage,
    runContainer,
    listContainers,
    stopContainer,
    startContainer,
    restartContainer,
    removeContainer,
    getContainerLogs,
    getContainerIp,
    getPublishedHostPort,
    WORKLOAD_PORT,
} from '../docker.js';

const REVERSE_PROXY_HOST = process.env.REVERSE_PROXY_HOST ?? 'localhost';

export const name = 'docker';

// Containers live on a private bridge network, so VoiDock has to proxy to them.
export const needsProxy = true;

function decorate(container) {
    const domain = `${container.name}.${REVERSE_PROXY_HOST}`;
    const published = container.ports?.find((p) => p.PublicPort);

    return {
        ...container,
        domain,
        url: `http://${domain}`,
        tcpAddress: published ? `${REVERSE_PROXY_HOST}:${published.PublicPort}` : null,
    };
}

export async function create({ image, tag, port, env }) {
    await ensureImage(image, tag);
    const inspect = await runContainer(image, tag, { tcpPort: port, env });

    const record = decorate({
        id: inspect.Id,
        name: inspect.Name.replace('/', ''),
        image: `${image}:${tag}`,
        state: inspect.State?.Status,
        status: inspect.State?.Status,
    });

    if (port) {
        const hostPort = getPublishedHostPort(inspect, port);
        // Raw TCP passthrough, not an HTTP proxy: for protocols the reverse proxy
        // can't speak (Postgres, Redis, ...), connect straight to this address
        // with the service's own client (redis-cli, psql, ...), not a browser.
        record.tcpAddress = hostPort ? `${REVERSE_PROXY_HOST}:${hostPort}` : null;
    }

    return record;
}

export async function list() {
    return (await listContainers()).map(decorate);
}

export async function stop(id) {
    await stopContainer(id);
}

export async function start(id) {
    await startContainer(id);
}

export async function restart(id) {
    await restartContainer(id);
}

export async function remove(id) {
    await removeContainer(id);
}

export async function logs(id, tail = 100) {
    return getContainerLogs(id, tail);
}

// Maps the leading subdomain label of an incoming request to an upstream origin.
// Throws a tagged error so the proxy can pick the right HTTP status.
export async function resolveTarget(hostLabel) {
    const containers = await listContainers();
    const container = containers.find((c) => c.name === hostLabel);

    if (!container) {
        throw Object.assign(new Error(`Container "${hostLabel}" not found.`), {
            status: 404,
        });
    }

    if (container.state !== 'running') {
        throw Object.assign(
            new Error(
                `Container "${hostLabel}" is not running (state: ${container.state}).`
            ),
            { status: 503 }
        );
    }

    const ip = await getContainerIp(container.id);

    if (!ip) {
        throw Object.assign(
            new Error(`Container "${hostLabel}" not connected to voidock-network.`),
            { status: 502 }
        );
    }

    return `http://${ip}:${WORKLOAD_PORT}`;
}
