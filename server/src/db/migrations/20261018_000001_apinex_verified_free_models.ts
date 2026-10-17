import type { Db } from '../types.js';

/**
 * Bundled, conservatively verified APInex Free chat roster.
 *
 * APInex has many additional free/* IDs, but most have not been confirmed for
 * inference. Ship only the five live chat-PASS routes (2026-10-17).
 * No paid route is inserted. Source='user' intentionally protects these bundled
 * bootstrap entries from the signed remote catalog's unrelated pruning; a
 * later signed APInex catalog can still coexist with the same IDs.
 *
 * The reported 1M-token gateway context is not a per-model verified capacity,
 * so context_window remains NULL rather than asserting a false per-model limit.
 */
const VERIFIED = [
  { id: 'free/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', tools: 1 },
  { id: 'free/gemini-3.8-flash', name: 'Gemini 3.8 Flash', tools: 0 },
  { id: 'free/glm-5.3', name: 'GLM 5.3', tools: 0 },
  { id: 'free/glm-5.3-flash', name: 'GLM 5.3 Flash', tools: 0 },
  { id: 'free/gpt-6-luna', name: 'GPT-6 Luna', tools: 1 },
] as const;

export function up(db: Db): void {
  const existing = db.prepare("SELECT id FROM models WHERE platform = 'apinex' AND model_id = ? AND endpoint_scope = ''");
  // During migration round-trips the earlier provenance migration drops and
  // recreates source. Restore origin for *our exact bootstrap rows* only.
  const restoreBundledSource = db.prepare(
    "UPDATE models SET source='user' WHERE platform='apinex' AND model_id=? AND display_name=? AND source='catalog' AND endpoint_scope='' AND context_window IS NULL AND monthly_token_budget=''"
  );
  const wasDeleted = db.prepare("SELECT 1 FROM catalog_model_tombstones WHERE kind='chat' AND platform='apinex' AND model_id=? AND source='user'");
  const add = db.prepare(`
    INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank,
       size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
       context_window, enabled, key_id, supports_tools, supports_vision, source, endpoint_scope)
    VALUES ('apinex', ?, ?, 50, 50, '', NULL, NULL, NULL, NULL, '',
            NULL, 1, NULL, ?, 0, 'user', '')
    ON CONFLICT(platform, model_id, endpoint_scope) DO NOTHING
  `);
  const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS n FROM fallback_config');
  const addFallback = db.prepare('INSERT OR IGNORE INTO fallback_config(model_db_id, priority, enabled) VALUES (?, ?, 1)');
  const allProfiles = db.prepare('SELECT id FROM profiles');
  const profileMaxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS n FROM profile_models WHERE profile_id = ?');
  const addProfile = db.prepare('INSERT OR IGNORE INTO profile_models(profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)');
  for (const m of VERIFIED) {
    if (wasDeleted.get(m.id)) continue; // Respect explicit deletions.
    if (existing.get(m.id)) {
      restoreBundledSource.run(m.id, m.name);
      continue; // Keep user edits and other metadata intact.
    }
    add.run(m.id, m.name, m.tools);
    const row = existing.get(m.id) as { id: number } | undefined;
    if (!row) continue;
    const max = maxPriority.get() as { n: number };
    addFallback.run(row.id, max.n + 1);
    for (const profile of allProfiles.all() as { id: number }[]) {
      const pmax = profileMaxPriority.get(profile.id) as { n: number };
      addProfile.run(profile.id, row.id, pmax.n + 1);
    }
  }
  db.prepare("INSERT INTO settings(key,value) VALUES('apinex_verified_roster_seed_v1','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
}

export function down(db: Db): void {
  // Model rows are intentionally persistent across downgrades: dropping them
  // would destroy user edits or orphan profiles. The marker is reversible and
  // records which code version bootstrapped the roster.
  db.prepare("DELETE FROM settings WHERE key='apinex_verified_roster_seed_v1'").run();
}
