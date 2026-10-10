import { Router } from 'express';
import type { Request, Response } from 'express';
import { providerPacingRuntimeStatus } from '../services/provider-pacing-routing.js';
import { readProviderPacingConfig } from '../services/provider-pacing-store.js';

export const providerPacingRouter = Router();

// app.ts mounts this router behind requireAuth (dashboard login).
// No API key, proxy URL, prompt, client id or queue body is exposed.
providerPacingRouter.get('/status', (_req: Request, res: Response) => {
  try {
    const saved = readProviderPacingConfig();
    res.json({
      schemaVersion: saved.schemaVersion,
      revision: saved.revision,
      configEnabled: saved.config.enabled,
      ...providerPacingRuntimeStatus(),
    });
  } catch {
    res.status(503).json({ error: {
      code: 'pacing_store_error',
      message: 'Provider pacing status unavailable',
    } });
  }
});
