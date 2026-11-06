/**
 * HTTP /health endpoint (required by the spec, design decision #8).
 *
 * Deliberately dependency-free (Node's built-in http). Reports liveness plus a
 * quick DB connectivity check, so it is a genuine readiness signal, not a static
 * 200. Returns 503 when the database can't be reached.
 */

import http from 'node:http';
import type { Db } from '../db/index.js';
import type { Logger } from '../lib/logger.js';

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface HealthDeps {
  readonly port: number;
  readonly db: Db;
  readonly logger: Logger;
}

export function startHealthServer(deps: HealthDeps): Promise<HealthServer> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    deps.db
      .query('SELECT 1')
      .then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', db: 'up' }));
      })
      .catch((err: unknown) => {
        deps.logger.warn('health check: db unreachable', { error: String(err) });
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'degraded', db: 'down' }));
      });
  });

  return new Promise<HealthServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, () => {
      deps.logger.info('health endpoint listening', { port: deps.port });
      resolve({
        port: deps.port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
