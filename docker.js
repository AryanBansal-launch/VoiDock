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

export async function runContainer(image, tag) {
    await ensureNetwork();

    const container = await docker.createContainer({
        Image: `${image}:${tag}`,
        ExposedPorts: {
            '80/tcp': {},
        },
        HostConfig: {
            AutoRemove: true,
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

export async function getContainerLogs(containerId, tail = 100) {
    const container = docker.getContainer(containerId);
    const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail,
    });
    return logs.toString();
}

export default docker;
