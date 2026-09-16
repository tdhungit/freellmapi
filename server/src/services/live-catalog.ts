import { getDb, getSetting, setSetting } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';
import { decrypt } from '../lib/crypto.js';
import { resolveProvider } from '../providers/index.js';
import { parseModelCatalog, readCappedBody } from './model-discovery.js';
import { customModelSeed } from './custom-model-seed.js';
import { ensureModelInProfiles } from './profile-models.js';
import { clearCatalogModelTombstone } from './model-state.js';

// ── Live catalog ─────────────────────────────────────────────────────────────
//
// The static catalog (catalog-sync, monthly snapshot for free tier) lags behind
// what providers actually serve. This syncs ONE platform live: GET the
// provider's own /models with the operator's stored key, and INSERT any ids
// the local `models` table doesn't have yet.
//
// Reuses the provider adapter's fetchModelCatalog + model-discovery's envelope
// parser (same code path as custom-endpoint "Fetch models"), so no new HTTP or
// parsing logic lives here. Deliberately insert-only with source='user':
// existing rows (catalog-managed or operator-tuned) are never touched, and
// catalog-sync's prune only considers source='catalog', so live rows survive
// every static sync without a migration. Non-chat kinds (embedding/image/…)
/// belong to other tables — skipped here, chat only.

export interface LiveSyncResult {
  platform: string;
  ok: boolean;
  /** New rows inserted (0 when already up to date). */
  inserted: number;
  /** Live ids seen (chat only). */
  live: number;
  skipped?: string;
  error?: string;
}

export async function syncLivePlatform(platform: string): Promise<LiveSyncResult> {
  const db = getDb();
  const provider = resolveProvider(platform as never) as
    | { fetchModelCatalog?: (key: string) => Promise<Response> }
    | undefined;
  if (!provider || typeof provider.fetchModelCatalog !== 'function') {
    return { platform, ok: true, inserted: 0, live: 0, skipped: 'provider has no live /models endpoint' };
  }
  const keyRows = db.prepare(
    "SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ORDER BY id",
  ).all(platform) as { encrypted_key: string; iv: string; auth_tag: string }[];
  let apiKey: string | null = null;
  for (const r of keyRows) {
    try { apiKey = decrypt(r.encrypted_key, r.iv, r.auth_tag); break; } catch { /* try next */ }
  }
  if (!apiKey) return { platform, ok: true, inserted: 0, live: 0, skipped: 'no decryptable enabled key' };

  let res: Response;
  try {
    res = await provider.fetchModelCatalog(apiKey);
  } catch (err) {
    return { platform, ok: false, inserted: 0, live: 0, error: (err as Error)?.message ?? 'unreachable' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readCappedBody(res));
  } catch (err) {
    return { platform, ok: false, inserted: 0, live: 0, error: (err as Error)?.message ?? 'unreadable catalog' };
  }
  if (!res.ok) return { platform, ok: false, inserted: 0, live: 0, error: `provider returned HTTP ${res.status}` };

  // Chat only — media/embedding kinds live in other tables.
  const discovered = parseModelCatalog(payload).filter(m => !m.kind);
  const seed = customModelSeed(db);
  const exists = db.prepare('SELECT 1 FROM models WHERE platform = ? AND model_id = ?');
  const insert = db.prepare(`
    INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
       enabled, supports_vision, supports_tools, source, endpoint_scope)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', ?, 1, ?, 1, 'user', '')
  `);
  let inserted = 0;
  const apply = db.transaction(() => {
    for (const m of discovered) {
      if (exists.get(platform, m.id)) continue;
      // ponytail: live re-add lifts a prior delete; explicit operator deletes
      // of catalog rows stay tombstoned only when the id is also in the static
      // catalog (catalog-sync re-applies it) — a live-only id is user data.
      clearCatalogModelTombstone(db, 'chat', platform, m.id);
      const info = insert.run(
        platform, m.id, m.id,
        seed.intelligenceRank, seed.speedRank, seed.sizeLabel,
        m.contextWindow ?? null, m.vision ? 1 : 0,
      );
      const modelDbId = Number(info.lastInsertRowid);
      if (!db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId)) {
        const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
        db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, max.m + 1);
      }
      ensureModelInProfiles(db, modelDbId);
      inserted++;
    }
  });
  apply();
  return { platform, ok: true, inserted, live: discovered.length };
}

/** Best-effort live sync for every platform holding an enabled key. */
export async function syncAllLivePlatforms(): Promise<LiveSyncResult[]> {
  const db = getDb();
  const platforms = db.prepare(
    "SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 AND platform != 'custom'",
  ).all() as { platform: string }[];
  const out: LiveSyncResult[] = [];
  for (const { platform } of platforms) {
    try { out.push(await syncLivePlatform(platform)); }
    catch (err) { out.push({ platform, ok: false, inserted: 0, live: 0, error: (err as Error)?.message ?? 'failed' }); }
  }
  // A manual run also resets the scheduled timer, so the next auto pass is
  // measured from the freshest sync, not from a stale timestamp.
  try { setSetting(LIVE_SYNC_LAST_RUN_SETTING, new Date().toISOString()); } catch { /* best-effort */ }
  return out;
}

// ── Scheduled live sync ────────────────────────────────────────────────────
//
// The dashboard's Settings dialog owns the interval (days) and the manual
// run button (POST /api/models/live-sync, already the route above). This
// only adds the timer: a daily tick that runs the same syncAllLivePlatforms
// once the configured days have elapsed since the last run.
export const LIVE_SYNC_INTERVAL_SETTING = 'live_sync_interval_days';
export const LIVE_SYNC_LAST_RUN_SETTING = 'live_sync_last_run';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Configured auto-sync interval in days (1..365, default 1). Read fresh on
 *  every tick, so a Settings change applies without a restart. */
export function getLiveSyncIntervalDays(): number {
  const raw = Number(getSetting(LIVE_SYNC_INTERVAL_SETTING));
  return Number.isInteger(raw) && raw >= 1 && raw <= 365 ? raw : 1;
}

export function startLiveCatalogSync(scheduler: Scheduler): () => void {
  const tick = () => {
    const last = Date.parse(getSetting(LIVE_SYNC_LAST_RUN_SETTING) ?? '');
    if (!Number.isNaN(last) && Date.now() - last < getLiveSyncIntervalDays() * DAY_MS) return;
    void syncAllLivePlatforms().catch(err =>
      console.warn('[live-catalog] scheduled sync failed:', (err as Error)?.message ?? err),
    );
  };
  // Boot-delayed due-check (a stale timer fires ~1min after start) plus the
  // daily tick; both re-read the interval, so neither needs rescheduling.
  const cancelBoot = scheduler.after(60 * 1000, tick);
  const cancelDaily = scheduler.every(DAY_MS, tick, { name: 'live-catalog-sync' });
  return () => { cancelBoot(); cancelDaily(); };
}
