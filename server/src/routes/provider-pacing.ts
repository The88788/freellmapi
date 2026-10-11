import { Router } from 'express';
import type { Request, Response } from 'express';
import { providerPacingRuntimeStatus } from '../services/provider-pacing-routing.js';
import { readProviderPacingConfig } from '../services/provider-pacing-store.js';
import { getProvider } from '../providers/index.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';

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
      // The values are snapshots of the actual constructed adapters. Editing
      // process.env without restarting cannot falsify the reported chat timeout.
      providerTimeouts: Object.fromEntries(
        (['pollinations', 'nvidia', 'mistral'] as const).flatMap(platform => {
          const provider = getProvider(platform);
          return provider instanceof OpenAICompatProvider
            ? [[platform, provider.getTimeoutStatus()] as const]
            : [];
        }),
      ),
    });
  } catch {
    res.status(503).json({ error: {
      code: 'pacing_store_error',
      message: 'Provider pacing status unavailable',
    } });
  }
});
