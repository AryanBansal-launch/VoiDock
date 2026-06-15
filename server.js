import express from 'express';

import { ensureImage, runContainer } from './docker.js';

const MANAGEMENT_APP_PORT = process.env.MANAGEMENT_APP_PORT || 8080;
const REVERSE_PROXY_HOST = process.env.REVERSE_PROXY_HOST ?? 'localhost';

const managementApp = express();
managementApp.use(express.json());

managementApp.get('/', (req, res) => {
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

        return res.json({
            status: 'success',
            data: {
                containerName: inspect.Name,
                domain: `${inspect.Name}.${REVERSE_PROXY_HOST}`,
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

managementApp.listen(MANAGEMENT_APP_PORT, () => {
    console.log(`Management API is running on PORT : ${MANAGEMENT_APP_PORT}`);
});
