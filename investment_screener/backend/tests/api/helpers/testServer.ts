/**
 * testServer.ts - tiny express harness for route specs.
 *
 * Purpose:
 *   Mounts one router on an ephemeral localhost port so a spec can exercise the real
 *   Express stack (status codes, JSON bodies, query parsing) with global fetch, without
 *   adding a supertest dependency.
 *
 * Layer:
 *   Backend / Tests / Helpers
 *
 * Usage Examples:
 *   await withRouter(createSourcesRouter(deps), async (base) => {
 *       const res = await fetch(`${base}/api/sources`);
 *   });
 *
 * Key Functions (Index):
 *   - withRouter(router, fn) - start, run the callback with the base URL, always close
 *
 * Key Input Dependencies:
 *   None (no database, no network beyond loopback)
 *
 * Key Output Dependencies:
 *   None
 */
import express from 'express';
import type { AddressInfo } from 'net';

export async function withRouter(
    router: express.Router,
    fn: (baseUrl: string) => Promise<void>,
    mountPath = '/api'
): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use(mountPath, router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}
