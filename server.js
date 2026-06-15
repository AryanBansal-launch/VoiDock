import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import httpProxy from 'http-proxy';

import { ensureImage, runContainer, listContainers } from './docker.js';

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

managementApp.listen(MANAGEMENT_APP_PORT, () => {
    console.log(`Management API is running on PORT : ${MANAGEMENT_APP_PORT}`);
});


//Revrese proxy server
proxyApp.use((req,res)=>{
    const containerName = req.hostname.split('.')[0];
    return proxy.web(req,res,{
        target : `http://${containerName}:80`
    })
})

proxyApp.listen(80, ()=>{
    console.log('Reverse proxy is running on port 80');
})