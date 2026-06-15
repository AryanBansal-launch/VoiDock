import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import httpProxy from 'http-proxy';

import {
    ensureImage,
    runContainer,
    listContainers,
    stopContainer,
    startContainer,
    restartContainer,
    removeContainer,
    getContainerLogs,
} from './docker.js';
import docker from './docker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, 'index.html'));

const MANAGEMENT_APP_PORT = process.env.MANAGEMENT_APP_PORT || 8080;
const REVERSE_PROXY_HOST = process.env.REVERSE_PROXY_HOST ?? 'localhost';

const managementApp = express();
const proxyApp = express()
const proxy = httpProxy.createProxy();
managementApp.use(express.json());
managementApp.use(cors());

managementApp.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    return res.send(indexHtml);
});

managementApp.get('/health', (_req, res) => {
    return res.json({ status: 'Management App is up and Running.' });
});

managementApp.post('/container', async (req, res) => {
    const { image, tag } = req.body;

    if (!image || !tag) {
        return res.status(400).json({
            status: 'error',
            message: 'Both "image" and "tag" are required.',
        });
    }

    try {
        await ensureImage(image, tag);
        const inspect = await runContainer(image, tag);

        const domain = `${inspect.Name.replace('/', '')}.${REVERSE_PROXY_HOST}`;

        return res.json({
            status: 'success',
            data: {
                containerName: inspect.Name.replace('/', ''),
                domain,
                url: `http://${domain}`,
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
        const containers = await listContainers();

        return res.json({
            status: 'success',
            data: containers.map((container) => {
                const domain = `${container.name}.${REVERSE_PROXY_HOST}`;
        
                return {
                    ...container,
                    domain,
                    url: `http://${domain}`,
                };
            }),
        });
    } catch (err) {
        console.error('Failed to list containers:', err);

        return res.status(500).json({
            status: 'error',
            message: err.message,
        });
    }
});

managementApp.post('/container/:id/stop', async (req, res) => {
    try {
        await stopContainer(req.params.id);
        return res.json({ status: 'success', message: 'Container stopped' });
    } catch (err) {
        console.error('Failed to stop container:', err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

managementApp.post('/container/:id/start', async (req, res) => {
    try {
        await startContainer(req.params.id);
        return res.json({ status: 'success', message: 'Container started' });
    } catch (err) {
        console.error('Failed to start container:', err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

managementApp.post('/container/:id/restart', async (req, res) => {
    try {
        await restartContainer(req.params.id);
        return res.json({ status: 'success', message: 'Container restarted' });
    } catch (err) {
        console.error('Failed to restart container:', err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

managementApp.delete('/container/:id', async (req, res) => {
    try {
        await removeContainer(req.params.id);
        return res.json({ status: 'success', message: 'Container removed' });
    } catch (err) {
        console.error('Failed to remove container:', err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

managementApp.get('/container/:id/logs', async (req, res) => {
    try {
        const tail = parseInt(req.query.tail) || 100;
        const logs = await getContainerLogs(req.params.id, tail);
        return res.json({ status: 'success', data: logs });
    } catch (err) {
        console.error('Failed to get logs:', err);
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

managementApp.listen(MANAGEMENT_APP_PORT, () => {
    console.log(`Management API is running on PORT : ${MANAGEMENT_APP_PORT}`);
});


// Reverse proxy server
proxyApp.use(async (req, res) => {
    const containerName = req.hostname.split('.')[0];

    try {
        const containers = await listContainers();
        const container = containers.find((c) => c.name === containerName);

        if (!container) {
            return res.status(404).json({
                status: 'error',
                message: `Container "${containerName}" not found.`,
            });
        }

        if (container.state !== 'running') {
            return res.status(503).json({
                status: 'error',
                message: `Container "${containerName}" is not running (state: ${container.state}).`,
            });
        }

        const dockerContainer = docker.getContainer(container.id);
        const inspect = await dockerContainer.inspect();
        const ip =
            inspect.NetworkSettings.Networks['voidock-network']?.IPAddress;

        if (!ip) {
            return res.status(502).json({
                status: 'error',
                message: `Container "${containerName}" not connected to voidock-network.`,
            });
        }

        const target = `http://${ip}:80`;
        proxy.web(req, res, { target }, (err) => {
            if (!res.headersSent) {
                console.error(`Proxy error for ${containerName} (${ip}):`, err.message);
                return res.status(502).json({
                    status: 'error',
                    message: `Failed to proxy request: ${err.message}`,
                });
            }
        });
    } catch (err) {
        if (!res.headersSent) {
            console.error('Proxy lookup error:', err.message);
            return res.status(500).json({
                status: 'error',
                message: `Internal proxy error: ${err.message}`,
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