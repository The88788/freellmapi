#!/usr/bin/env python3
"""One-shot SQLite curation for the operator's verified APInex free routes.

No API requests. Only discovered APInex rows are touched. This is a local
operator script, NOT a FreeLLMAPI catalog migration.
"""
import datetime as dt
import os
from pathlib import Path
import sqlite3
import sys

DB = Path('/var/lib/freellmapi/freeapi.db')
BACKUP_ROOT = Path('/root/freellmapi-backups')
# Observed chat PASS on five models; only DeepSeek's tool calls were separately verified.
KEEP = {
    'free/deepseek-v4.1-flash': ('DeepSeek V4.1 Flash', 1),
    'free/gemini-3.8-flash': ('Gemini 3.8 Flash', 0),
    'free/glm-5.3': ('GLM 5.3', 0),
    'free/glm-5.3-flash': ('GLM 5.3 Flash', 0),
    'free/gpt-6-luna': ('GPT-6 Luna', 0),
}

def main():
    if os.geteuid() != 0 or not DB.is_file():
        raise RuntimeError('Must run as root with an existing FreeLLMAPI SQLite database')
    db = sqlite3.connect(f'file:{DB}?mode=rw', uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA busy_timeout=30000')
    try:
        tables = {
            'models': {'id','platform','model_id','display_name','source','enabled','supports_tools','supports_vision'},
            'fallback_config': {'model_db_id','enabled'},
            'profile_models': {'model_db_id','enabled'},
            'model_overrides': {'platform','model_id'},
            'catalog_model_tombstones': {'kind','platform','model_id','source','reason'},
        }
        for table, columns in tables.items():
            available = {r['name'] for r in db.execute(f'PRAGMA table_info({table})')}
            if not columns.issubset(available):
                raise RuntimeError(f'Unexpected DB schema in {table}, no changes made')

        rows = db.execute("SELECT id,model_id,source FROM models WHERE platform='apinex' ORDER BY id").fetchall()
        index = {r['model_id']: r for r in rows}
        if not set(KEEP).issubset(index):
            raise RuntimeError(f'Five verified APInex model IDs not all present; found {len(rows)} rows; no changes made')
        if any(r['source'] != 'discovered' for r in rows):
            raise RuntimeError('Catalog or user-owned APInex models present; no changes made')
        prune = [r for r in rows if r['model_id'] not in KEEP]
        print(f'APInex: keep {len(KEEP)}, remove {len(prune)} unverified discovered routes')
        print('Tools enabled only for verified DeepSeek V4.1 Flash; Vision disabled until tested')

        os.umask(0o077)
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        directory = BACKUP_ROOT / f'apinex-curation-{stamp}'
        directory.mkdir(parents=True, mode=0o700, exist_ok=False)
        backup_path = directory / 'freeapi.db'
        with sqlite3.connect(str(backup_path)) as backup:
            db.backup(backup)
            if backup.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('SQLite backup verification failed')
        print(f'BACKUP=PASS {backup_path}')

        db.execute('BEGIN IMMEDIATE')
        try:
            for row in prune:
                model_id, model_db_id = row['model_id'], row['id']
                # Same cleanup and tombstone semantics as DELETE /api/models/:id.
                db.execute("""INSERT INTO catalog_model_tombstones(kind,platform,model_id,source,reason)
                    VALUES ('chat','apinex',?,'user','Unverified, removed by operator')
                    ON CONFLICT(kind,platform,model_id)
                    DO UPDATE SET source=excluded.source,reason=excluded.reason,created_at=datetime('now')
                """, (model_id,))
                db.execute("DELETE FROM model_overrides WHERE platform='apinex' AND model_id=?", (model_id,))
                db.execute('DELETE FROM fallback_config WHERE model_db_id=?', (model_db_id,))
                db.execute('DELETE FROM profile_models WHERE model_db_id=?', (model_db_id,))
                db.execute('DELETE FROM models WHERE id=?', (model_db_id,))
            for model_id, (name, tools) in KEEP.items():
                db.execute("""UPDATE models SET display_name=?,enabled=1,supports_tools=?,supports_vision=0
                              WHERE platform='apinex' AND model_id=? AND source='discovered'""",
                           (name, tools, model_id))
                # Explicit pinned DSH calls still work, without polluting auto chains.
                db.execute('UPDATE fallback_config SET enabled=0 WHERE model_db_id=?', (index[model_id]['id'],))
                db.execute('UPDATE profile_models SET enabled=0 WHERE model_db_id=?', (index[model_id]['id'],))
            after = db.execute("SELECT model_id,display_name FROM models WHERE platform='apinex' ORDER BY model_id").fetchall()
            if len(after) != 5 or {r['model_id'] for r in after} != set(KEEP):
                raise RuntimeError('Post-update check failed; rolling back')
            db.commit()
        except BaseException:
            db.rollback()
            raise
        print('=== APInex curated models ===')
        for row in after:
            print(f"{row['model_id']} -> {row['display_name']}")
        print(f'APINEX_CURATION=PASS kept=5 removed={len(prune)}')
        print('No API calls, service restarts or changes to other providers.')
    finally:
        db.close()

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, sqlite3.Error) as exc:
        print(f'APINEX_CURATION=FAIL: {exc}', file=sys.stderr)
        sys.exit(1)
