import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import httpProxy from 'http-proxy';

import driver from './drivers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, 'index.html'));

// Vercel routes container traffic to :80 unless PORT is set in project settings.
const MANAGEMENT_APP_PORT =
    process.env.PORT ??
    process.env.MANAGEMENT_APP_PORT ??
    (process.env.VERCEL ? 80 : 8080);

const managementApp = express();
managementApp.use(express.json());
managementApp.use(cors());

managementApp.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    return res.send(indexHtml);
});

managementApp.get('/health', (_req, res) => {
    return res.json({
        status: 'Management App is up and Running.',
        driver: driver.name,
    });
});

managementApp.post('/container', async (req, res) => {
    const { image, tag, port, env } = req.body;

    if (!image || !tag) {
        return res.status(400).json({
            status: 'error',
            message: 'Both "image" and "tag" are required.',
        });
    }

    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        return res.status(400).json({
            status: 'error',
            message: '"port" must be an integer between 1 and 65535.',
        });
    }

    if (
        env !== undefined &&
        (typeof env !== 'object' || env === null || Array.isArray(env) ||
            Object.values(env).some((v) => typeof v !== 'string'))
    ) {
        return res.status(400).json({
            status: 'error',
            message: '"env" must be a flat object of string values, e.g. {"POSTGRES_PASSWORD": "..."}.',
        });
    }

    try {
        const container = await driver.create({ image, tag, port, env });

        return res.json({
            status: 'success',
            data: {
                containerName: container.name,
                domain: container.domain,
                url: container.url,
                // Raw TCP passthrough for non-HTTP images (Redis, Postgres, ...) —
                // only set when `port` was requested and the driver supports it.
                tcpAddress: container.tcpAddress ?? null,
            },
        });
    } catch (err) {
        console.error('Failed to start container:', err);
        return res.status(500).json({
            status: 'error',
            message: err.message,
        });
    }
});

managementApp.get('/list', async (_req, res) => {
    try {
        return res.json({
            status: 'success',
            data: await driver.list(),
        });
    } catch (err) {
        console.error('Failed to list containers:', err);

        return res.status(500).json({
            status: 'error',
            message: err.message,
        });
    }
});

// stop/start/restart/delete differ only in the driver call and the past-tense word
// in the response, so register them from one table.
const LIFECYCLE = [
    { path: '/container/:id/stop', method: 'post', action: 'stop', past: 'stopped' },
    { path: '/container/:id/start', method: 'post', action: 'start', past: 'started' },
    { path: '/container/:id/restart', method: 'post', action: 'restart', past: 'restarted' },
    { path: '/container/:id', method: 'delete', action: 'remove', past: 'removed' },
];

for (const { path, method, action, past } of LIFECYCLE) {
    managementApp[method](path, async (req, res) => {
        try {
            await driver[action](req.params.id);
            return res.json({ status: 'success', message: `Container ${past}` });
        } catch (err) {
            console.error(`Failed to ${action} container:`, err);
            return res.status(500).json({ status: 'error', message: err.message });
        }
    });
}

managementApp.get('/container/:id/logs', async (req, res) => {
    try {
        const tail = parseInt(req.query.tail) || 100;
        const logs = await driver.logs(req.params.id, tail);
        return res.json({ status: 'success', data: logs });
    } catch (err) {
        console.error('Failed to get logs:', err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

managementApp.listen(MANAGEMENT_APP_PORT, () => {
    console.log(
        `Management API is running on PORT : ${MANAGEMENT_APP_PORT} (driver: ${driver.name})`
    );
});

// Reverse proxy server
//
// Only drivers that put workloads on a private network need this. The sandbox
// driver hands out public URLs directly, and binding :80 would fail on Vercel.
if (driver.needsProxy) {
    const proxyApp = express();
    const proxy = httpProxy.createProxy();

    proxyApp.use(async (req, res) => {
        const hostLabel = req.hostname.split('.')[0];

        try {
            const target = await driver.resolveTarget(hostLabel);

            proxy.web(req, res, { target }, (err) => {
                if (!res.headersSent) {
                    console.error(`Proxy error for ${hostLabel}:`, err.message);
                    return res.status(502).json({
                        status: 'error',
                        message: `Failed to proxy request: ${err.message}`,
                    });
                }
            });
        } catch (err) {
            if (!res.headersSent) {
                console.error('Proxy lookup error:', err.message);
                return res.status(err.status ?? 500).json({
                    status: 'error',
                    message: err.message,
                });
            }
        }
    });

    proxy.on('error', (err, _req, res) => {
        if (!res.headersSent) {
            res.status(502).json({
                status: 'error',
                message: `Proxy error: ${err.message}`,
            });
        }
    });

    proxyApp.listen(80, () => {
        console.log('Reverse proxy is running on port 80');
    });
}
