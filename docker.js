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

export async function runContainer(image, tag) {
    const container = await docker.createContainer({
        Image: `${image}:${tag}`,
        HostConfig: {
            AutoRemove: true,
        },
    });

    const inspect = await container.inspect();

    const network = docker.getNetwork('deploy-engine-netowrk');

    try {
        await network.connect({
            Container: inspect.Id,
        });
    } catch (err) {
        console.warn(
            `Failed to connect container to network: ${err.message}`
        );
    }

    await container.start();

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

export default docker;
