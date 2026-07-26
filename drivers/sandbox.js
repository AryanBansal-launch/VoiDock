import { randomUUID } from 'crypto';

// Imported lazily so the docker driver keeps working in installs that never
// pull @vercel/sandbox (and so a missing dep fails loudly at first use, not at boot).
let sandboxSdk;
async function sdk() {
    if (!sandboxSdk) {
        sandboxSdk = await import('@vercel/sandbox');
    }
    return sandboxSdk;
}

// Port the sandbox publishes to the internet. Declared at creation time because
// sandbox.domain() only resolves ports registered up front. This is the *public*
// side — it is unrelated to what port the workload listens on inside its container.
const SANDBOX_PORT = Number(process.env.SANDBOX_PORT ?? 8000);

// The port the workload listens on *inside* its container. Most non-nginx HTTP
// images don't default to 80 (Node apps commonly use 3000, Django 8000, Grafana
// 3000, ...) — this needs to match whatever the image actually binds. Protocols
// other than HTTP (Postgres, Redis, Kafka, ...) can never be reached through
// sandbox.domain() regardless of this setting — it's an HTTPS reverse proxy, not
// a raw TCP forward.
const WORKLOAD_PORT = Number(process.env.WORKLOAD_PORT ?? 80);

// Every sandbox hosts exactly one workload container under a fixed name, so the
// docker commands below never need to discover it.
const WORKLOAD = 'workload';

const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 30 * 60 * 1000);
const VCPUS = Number(process.env.SANDBOX_VCPUS ?? 2);

// How long to wait for the workload to answer on SANDBOX_PORT before giving up.
const READY_TIMEOUT_S = Number(process.env.SANDBOX_READY_TIMEOUT_S ?? 60);

// Tag every sandbox we own so list() never picks up sandboxes from other features
// sharing the same Vercel project.
const OWNER_TAG = { voidock: '1' };

// The Sandbox SDK's automatic OIDC detection reads a `globalThis` symbol that
// only Vercel's own Node.js/Edge function runtime populates per-request — a
// custom container image (Dockerfile.vercel) runs its own plain HTTP server
// instead, which Vercel just forwards raw traffic to, so that symbol is never
// set and OIDC auto-detection can never succeed here, no matter what's toggled
// in Project Settings. Verified by reading @vercel/oidc's own getContext().
// The fix is the SDK's other documented path: explicit access-token
// credentials, which bypass OIDC entirely. Locally these stay unset and the
// existing `vercel env pull`-based OIDC flow is untouched.
const CREDENTIALS =
    process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
        ? {
              token: process.env.VERCEL_TOKEN,
              teamId: process.env.VERCEL_TEAM_ID,
              projectId: process.env.VERCEL_PROJECT_ID,
          }
        : {};

export const name = 'sandbox';

// sandbox.domain() already hands out a public URL per workload.
export const needsProxy = false;

// Tag values are a restricted charset and image refs contain `/` and `.`, so round
// trip through base64url rather than lossily slugifying.
const encodeTag = (value) => Buffer.from(value, 'utf8').toString('base64url');
const decodeTag = (value) => {
    try {
        return Buffer.from(value, 'base64url').toString('utf8');
    } catch {
        return null;
    }
};

function sandboxName(image) {
    const slug = image.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `vd-${slug || 'app'}-${randomUUID().slice(0, 8)}`;
}

// The dashboard branches on Docker's state vocabulary, so translate rather than
// leaking sandbox lifecycle names into the API. `running` is deliberately absent:
// it's handled separately in record() because the VM reports `running` for the
// whole 30-60s the workload spends installing Docker and pulling the image, well
// before anything answers on SANDBOX_PORT.
const STATE_BY_STATUS = {
    pending: 'created',
    stopping: 'exited',
    snapshotting: 'exited',
    stopped: 'exited',
    aborted: 'dead',
    failed: 'dead',
};

// sandbox.domain() reads a server-assigned subdomain off the session's routes, so a
// URL can only come from a Sandbox instance — Sandbox.list() returns bare metadata.
// Subdomains are stable for a session, so cache them to keep /list to one API call
// per sandbox on a cold instance and zero afterwards.
const urlCache = new Map();

async function run(sandbox, cmd, args, { sudo = false } = {}) {
    return sandbox.runCommand({ cmd, args, sudo });
}

async function sh(sandbox, script) {
    return sandbox.runCommand({ cmd: 'sh', args: ['-lc', script] });
}

// Sandboxes boot without a container runtime, and a resumed sandbox restores its
// filesystem but not its processes — so dockerd has to be (re)started either way.
async function ensureDocker(sandbox) {
    if ((await sh(sandbox, 'sudo docker info >/dev/null 2>&1')).exitCode === 0) {
        return;
    }

    if ((await sh(sandbox, 'command -v dockerd >/dev/null 2>&1')).exitCode !== 0) {
        const install = await run(sandbox, 'dnf', ['install', '-y', 'docker'], {
            sudo: true,
        });

        if (install.exitCode !== 0) {
            throw new Error(
                `Failed to install docker in sandbox: ${await install.output('both')}`
            );
        }
    }

    await sandbox.runCommand({ sudo: true, cmd: 'dockerd', detached: true });

    const ready = await sh(
        sandbox,
        'for i in $(seq 1 60); do sudo docker info >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
    );

    if (ready.exitCode !== 0) {
        throw new Error('Docker daemon did not become ready in the sandbox.');
    }
}

// `env` is only applied when the container is (re)created here — a plain
// `docker start`/`docker restart` on the same container (the common stop/start
// path) reuses the Env it was created with, so nothing needs to be re-passed
// there. It's only lost if the container has to be recreated from scratch (the
// reviveWorkload() fallback below), an edge case not worth the complexity/risk
// of persisting secrets into sandbox tags to cover.
async function startWorkload(sandbox, image, tag, env) {
    const ref = `${image}:${tag}`;

    const pull = await run(sandbox, 'docker', ['pull', ref], { sudo: true });
    if (pull.exitCode !== 0) {
        throw new Error(`Failed to pull ${ref}: ${await pull.output('both')}`);
    }

    // Clear any container left behind by a previous session before rebinding the port.
    await run(sandbox, 'docker', ['rm', '-f', WORKLOAD], { sudo: true });

    const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    const started = await run(
        sandbox,
        'docker',
        ['run', '-d', '--name', WORKLOAD, '-p', `${SANDBOX_PORT}:${WORKLOAD_PORT}`, ...envArgs, ref],
        { sudo: true }
    );

    if (started.exitCode !== 0) {
        throw new Error(`Failed to start ${ref}: ${await started.output('both')}`);
    }

    await waitUntilServing(sandbox, ref);
}

// `docker run -d` returns as soon as the container is created, well before the
// process inside it binds a port. Returning then would hand back a URL that 502s
// with SANDBOX_NOT_LISTENING, so block until the port actually answers.
async function waitUntilServing(sandbox, ref) {
    const serving = await sh(
        sandbox,
        `for i in $(seq 1 ${READY_TIMEOUT_S}); do ` +
            `curl -sS -m 2 -o /dev/null http://localhost:${SANDBOX_PORT}/ && exit 0; ` +
            `sudo docker inspect -f '{{.State.Running}}' ${WORKLOAD} 2>/dev/null | grep -q false && exit 2; ` +
            'sleep 1; done; exit 1'
    );

    if (serving.exitCode === 2) {
        const logs = await run(sandbox, 'docker', ['logs', '--tail', '20', WORKLOAD], {
            sudo: true,
        });
        throw new Error(`${ref} exited on startup: ${await logs.output('both')}`);
    }

    if (serving.exitCode !== 0) {
        throw new Error(
            `${ref} started but nothing answered an HTTP request on port ` +
                `${WORKLOAD_PORT} (its container-internal port) within ${READY_TIMEOUT_S}s. ` +
                `If the image serves HTTP on a different port, set WORKLOAD_PORT to match. ` +
                'Non-HTTP services (databases, queues, etc.) cannot be reached through ' +
                'a sandbox URL at all — sandbox.domain() is an HTTPS reverse proxy, not a ' +
                'raw TCP forward.'
        );
    }
}

function urlFor(sandbox) {
    // domain() throws when the port has no route, e.g. while the VM is stopped.
    try {
        const url = sandbox.domain(SANDBOX_PORT);
        urlCache.set(sandbox.name, url);
        return url;
    } catch {
        return null;
    }
}

async function urlForName(name) {
    if (urlCache.has(name)) {
        return urlCache.get(name);
    }

    try {
        return urlFor(await get(name, { resume: false }));
    } catch {
        return null;
    }
}

// Returns the image this sandbox was created for, or null if the tags are missing
// or unreadable — callers must not guess a ref they can't recover.
function imageRefOf(meta) {
    const image = meta.tags?.image ? decodeTag(meta.tags.image) : null;
    const tag = meta.tags?.imagetag ? decodeTag(meta.tags.imagetag) : null;

    return image ? { image, tag: tag ?? 'latest' } : null;
}

// A sandbox reports `running` the moment its microVM boots — minutes before the
// workload inside it is installed, pulled and listening. Surfacing that as
// `running` with a live URL is how you get a link that 502s, so the workload's own
// readiness is tracked separately and only a serving workload gets a URL.
const isServing = (meta) => meta.status === 'running' && meta.tags?.ready === '1';

function record(meta, url) {
    const ref = imageRefOf(meta);
    const serving = isServing(meta);

    // Not Docker vocabulary, but the dashboard needs to tell "VM up, workload still
    // installing/pulling/binding its port" apart from an actually running workload.
    const state = serving
        ? 'running'
        : meta.status === 'running'
          ? 'starting'
          : (STATE_BY_STATUS[meta.status] ?? meta.status);

    return {
        id: meta.name,
        name: meta.name,
        image: ref ? `${ref.image}:${ref.tag}` : 'unknown',
        state,
        status:
            state === 'starting'
                ? 'Sandbox running, workload starting'
                : `Sandbox ${meta.status}`,
        // Sandbox URLs are always HTTPS on a Vercel-owned domain, so the bare host
        // doubles as the display domain.
        domain: url ? new URL(url).host : `${meta.name} (starting…)`,
        url: serving ? url : null,
    };
}

// Records readiness on the sandbox itself so any instance of the API — not just the
// one that handled the create — can tell a serving workload from a booting one.
// update() replaces the whole tag set, so every tag has to be resent.
async function markReady(sandbox, ready) {
    const ref = imageRefOf(sandbox);

    await sandbox.update({
        tags: {
            ...OWNER_TAG,
            ...(ref
                ? { image: encodeTag(ref.image), imagetag: encodeTag(ref.tag) }
                : {}),
            ready: ready ? '1' : '0',
        },
    });
}

async function get(id, { resume = true } = {}) {
    const { Sandbox } = await sdk();
    return Sandbox.get({ name: id, resume, ...CREDENTIALS });
}

export async function create({ image, tag, port, env }) {
    // sandbox.domain() is an HTTPS reverse proxy for the exposed port — there is
    // no raw TCP passthrough on Vercel Sandbox, so a non-HTTP workload (Redis,
    // Postgres, ...) can never be reached here the way the docker driver can.
    if (port) {
        throw new Error(
            'The sandbox driver only exposes workloads over HTTP(S) — Vercel ' +
                'Sandbox has no raw TCP passthrough. Direct TCP access to a ' +
                'non-HTTP service is only available with VOIDOCK_DRIVER=docker.'
        );
    }

    const { Sandbox } = await sdk();

    const sandbox = await Sandbox.create({
        name: sandboxName(image),
        ports: [SANDBOX_PORT],
        timeout: TIMEOUT_MS,
        resources: { vcpus: VCPUS },
        tags: {
            ...OWNER_TAG,
            image: encodeTag(image),
            imagetag: encodeTag(tag),
            ready: '0',
        },
        // Restarting dockerd on every resume is what makes stop/start survive.
        onResume: (sbx) => ensureDocker(sbx),
        ...CREDENTIALS,
    });

    try {
        await ensureDocker(sandbox);
        await startWorkload(sandbox, image, tag, env);
        await markReady(sandbox, true);
    } catch (err) {
        // A sandbox with no working workload is pure cost — don't leak it.
        await sandbox.delete().catch(() => {});
        throw err;
    }

    // startWorkload only returns once the port answers, so this URL is live.
    return record(
        { name: sandbox.name, status: 'running', tags: { ...OWNER_TAG, ready: '1', image: encodeTag(image), imagetag: encodeTag(tag) } },
        urlFor(sandbox)
    );
}

export async function list() {
    const { Sandbox } = await sdk();
    const result = await Sandbox.list({ tags: OWNER_TAG, ...CREDENTIALS });

    const metas = [];
    for await (const meta of result) {
        metas.push(meta);
    }

    return Promise.all(
        metas.map(async (meta) =>
            // Skip the per-sandbox URL lookup for anything not serving — it would be
            // discarded by record() anyway.
            record(meta, isServing(meta) ? await urlForName(meta.name) : null)
        )
    );
}

export async function stop(id) {
    const sandbox = await get(id, { resume: false });
    await sandbox.stop();
}

// `docker start`/`docker restart` fail when the snapshot predates the workload
// container, so fall back to a fresh run using the image recorded in the tags.
async function reviveWorkload(id, dockerVerb) {
    const sandbox = await get(id);
    const ref = imageRefOf(sandbox);

    // Clear readiness up front so a poll landing mid-restart can't hand out a URL
    // for a workload that isn't answering yet.
    await markReady(sandbox, false);
    await ensureDocker(sandbox);

    const result = await run(sandbox, 'docker', [dockerVerb, WORKLOAD], { sudo: true });

    if (result.exitCode === 0) {
        await waitUntilServing(sandbox, ref ? `${ref.image}:${ref.tag}` : WORKLOAD);
    } else {
        if (!ref) {
            throw new Error(
                `Cannot revive "${id}": no recoverable image tag on the sandbox.`
            );
        }
        await startWorkload(sandbox, ref.image, ref.tag);
    }

    await markReady(sandbox, true);
}

export async function start(id) {
    await reviveWorkload(id, 'start');
}

export async function restart(id) {
    await reviveWorkload(id, 'restart');
}

export async function remove(id) {
    const sandbox = await get(id, { resume: false });
    await sandbox.delete();
    urlCache.delete(id);
}

export async function logs(id, tail = 100) {
    // Reading logs resumes a stopped sandbox — dockerd has to be live to answer.
    const sandbox = await get(id);
    await ensureDocker(sandbox);

    const result = await run(
        sandbox,
        'docker',
        ['logs', '--tail', String(tail), WORKLOAD],
        { sudo: true }
    );

    return result.output('both');
}
