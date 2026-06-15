import Docker from 'dockerode';

const docker = new Docker();

/**
 * Pull a Docker image and wait until the download fully completes.
 *
 * `docker.pull`'s callback fires with the progress stream as soon as the
 * pull *starts*, so we must follow the stream to know when it's *done*.
 *
 * @param {string} image - Image name, e.g. "nginx".
 * @param {string} tag - Image tag, e.g. "latest".
 * @returns {Promise<true>} Resolves once the image is available locally.
 */
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

/**
 * Check whether an image:tag already exists locally.
 *
 * @param {string} image
 * @param {string} tag
 * @returns {Promise<boolean>}
 */
export async function imageExists(image, tag) {
    const ref = `${image}:${tag}`;
    const images = await docker.listImages();
    return images.some((img) => (img.RepoTags || []).includes(ref));
}

/**
 * Ensure an image is present locally, pulling it if necessary.
 *
 * @param {string} image
 * @param {string} tag
 */
export async function ensureImage(image, tag) {
    if (!(await imageExists(image, tag))) {
        await pullImage(image, tag);
    }
}

/**
 * Create and start a container for the given image:tag.
 *
 * @param {string} image
 * @param {string} tag
 * @returns {Promise<import('dockerode').ContainerInspectInfo>}
 */
export async function runContainer(image, tag) {
    const container = await docker.createContainer({
        Image: `${image}:${tag}`,
        HostConfig: {
            AutoRemove: true,
        },
    });

    await container.start();

    // TODO: connect this container to the host network so the reverse
    // proxy can route traffic to it.

    return container.inspect();
}

export default docker;
