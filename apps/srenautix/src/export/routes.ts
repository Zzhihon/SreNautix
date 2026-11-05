import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../identity/auth.js';
import { exportIncidents, parseExportQuery, type ExportDeps } from './incidents.js';
import { exportMarkdown, exportRecords } from './render.js';

export interface ExportRouteDeps extends ExportDeps {
  auth: Auth;
}

/** GET /v1/incidents/export（contract/openapi.yaml 的 exportIncidents，ADR 0186）：授权与可见性与 GET /v1/incidents 相同 */
export function registerExportRoutes(app: FastifyInstance, d: ExportRouteDeps): void {
  app.get('/v1/incidents/export', async (req, reply) => {
    const { scopes } = await d.auth.reader(req);
    const r = parseExportQuery(req.query as Record<string, unknown>);
    const x = await exportIncidents(d, scopes, r);
    if (r.format === 'md') {
      return reply.type('text/markdown; charset=utf-8').send(exportMarkdown(x));
    }
    if (r.format === 'ndjson') {
      const lines = (function* () {
        for (const rec of exportRecords(x)) {
          yield `${JSON.stringify(rec)}\n`;
        }
      })();
      return reply.type('application/x-ndjson; charset=utf-8').send(Readable.from(lines));
    }
    return x;
  });
}
