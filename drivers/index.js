const DRIVERS = {
    docker: () => import('./docker.js'),
    // Vercel Functions can't reach a Docker socket, so a Vercel deploy defaults to
    // driving Vercel Sandbox microVMs instead.
    sandbox: () => import('./sandbox.js'),
};

const selected =
    process.env.VOIDOCK_DRIVER ?? (process.env.VERCEL ? 'sandbox' : 'docker');

if (!DRIVERS[selected]) {
    throw new Error(
        `Unknown VOIDOCK_DRIVER "${selected}". Expected one of: ${Object.keys(DRIVERS).join(', ')}.`
    );
}

const driver = await DRIVERS[selected]();

export default driver;
