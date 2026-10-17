import type { Db } from '../types.js';

/** Local baseline for the five short-chat-verified APInex free routes.
 * 1M tokens is provider-claimed context (not independently stress-tested).
 * The 5 RPM is enforced globally by the adapter, not each model.
 */
const MODELS = [
  { id: 'free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', tools: 1 },
  { id: 'free/gemini-3.8-flash', name: 'Gemini 3.8 Flash', tools: 0 },
  { id: 'free/glm-5.3', name: 'GLM 5.3', tools: 0 },
  { id: 'free/glm-5.3-flash', name: 'GLM 5.3 Flash', tools: 0 },
  { id: 'free/gpt-6-luna', name: 'GPT-6 Luna', tools: 1 },
] as const;

export function up(db: Db): void {
  db.transaction(() => {
    const seed = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
         context_window, enabled, key_id, supports_tools, supports_vision, source, endpoint_scope)
      VALUES
        ('apinex', @id, @name, 500, 500, '', NULL, NULL, NULL, NULL, '',
         1000000, 1, NULL, @tools, 0, 'user', '')
      ON CONFLICT(platform, model_id, endpoint_scope) DO NOTHING
    `);
    const updateDiscovered = db.prepare(`
      UPDATE models SET display_name=@name, context_window=1000000,
             supports_tools=@tools, supports_vision=0, enabled=1, source='user'
       WHERE platform='apinex' AND model_id=@id AND source='discovered'
    `);
    for (const model of MODELS) {
      seed.run(model);
      updateDiscovered.run(model);
    }
    const ids = MODELS.map(m => m.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE models SET enabled=0 WHERE platform='apinex' AND model_id NOT IN (${placeholders})`).run(...ids);
    db.prepare(`UPDATE fallback_config SET enabled=0
        WHERE model_db_id IN (SELECT id FROM models WHERE platform='apinex' AND enabled=0)`).run();
    db.prepare(`UPDATE profile_models SET enabled=0
        WHERE model_db_id IN (SELECT id FROM models WHERE platform='apinex' AND enabled=0)`).run();
  })();
}

export function down(_db: Db): void {
  // Preserve user-edited data on downgrade.
}
