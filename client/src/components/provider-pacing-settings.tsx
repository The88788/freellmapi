import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

interface PacingRuleDraft {
  id: string
  enabled: boolean
  scope: string
  match?: Record<string, unknown>
  limits: Record<string, number>
  queue: { maxWaitMs: number; maxPendingPerBucket: number }
}

interface PacingConfigDraft {
  enabled: boolean
  maxPendingGlobal: number
  maxPendingPerClient: number
  rules: PacingRuleDraft[]
}

interface SavedPacingDocument {
  revision: number
  config: PacingConfigDraft
  runtimeEnabled: boolean
}

interface PacingRuntimeStatus {
  installed: boolean
  enabled: boolean
  configEnabled: boolean
  status: { pending: number; inflight: number; stopped: boolean }
  counters: { enqueued: number; admitted: number; cancelled: number; timedOut: number; overloaded: number }
}

/**
 * Stage 3 editor for DISABLED draft rules only. Activation is blocked by the
 * backend until integration tests and single-writer checks are completed.
 * Actual modelId and keyId must come from a real resolved provider route.
 */
export function ProviderPacingSettings({ open }: { open: boolean }) {
  const { locale } = useI18n()
  const ru = locale === 'ru'
  const [revision, setRevision] = useState(0)
  const [draft, setDraft] = useState('')
  const [runtime, setRuntime] = useState<PacingRuntimeStatus | null>(null)
  const [modelId, setModelId] = useState('')
  const [keyId, setKeyId] = useState('')
  const [intervalMs, setIntervalMs] = useState('65000')
  const [busy, setBusy] = useState<'load' | 'save' | 'validate' | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setBusy('load')
    setMessage('')
    setError('')
    Promise.all([
      apiFetch<SavedPacingDocument>('/api/settings/provider-pacing'),
      apiFetch<PacingRuntimeStatus>('/api/provider-pacing/status'),
    ]).then(([saved, status]) => {
      if (cancelled) return
      setRevision(saved.revision)
      setDraft(JSON.stringify(saved.config, null, 2))
      setRuntime(status)
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    }).finally(() => {
      if (!cancelled) setBusy(null)
    })
    return () => { cancelled = true }
  }, [open])

  const parse = (): PacingConfigDraft => {
    const obj: unknown = JSON.parse(draft)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Invalid JSON policy')
    const config = obj as PacingConfigDraft
    if (!Array.isArray(config.rules)) throw new Error('rules must be an array')
    return config
  }

  function addPollinationsRule() {
    setError('')
    setMessage('')
    const parsedKey = Number(keyId)
    const parsedInterval = Number(intervalMs)
    if (!modelId.trim() || !/^\d+$/.test(keyId) || !Number.isSafeInteger(parsedKey)
      || parsedKey <= 0 || !Number.isSafeInteger(parsedInterval) || parsedInterval < 1) {
      setError(ru
        ? 'Укажите фактический modelId, числовой keyId и положительный интервал.'
        : 'Enter the actual modelId, numeric keyId and a positive interval.')
      return
    }
    try {
      const config = parse()
      const id = 'pollinations-model-key-' + parsedKey
      if (config.rules.some(rule => rule.id === id)) {
        throw new Error(ru ? 'Правило для этого ключа уже есть.' : 'A rule for this key already exists.')
      }
      const rule: PacingRuleDraft = {
        id,
        enabled: true,
        scope: 'model-key',
        match: { platform: 'pollinations', modelId: modelId.trim(), keyId: parsedKey },
        limits: { minStartIntervalMs: parsedInterval, maxConcurrent: 1 },
        queue: { maxWaitMs: 180000, maxPendingPerBucket: 20 },
      }
      setDraft(JSON.stringify({ ...config, enabled: false, rules: [...config.rules, rule] }, null, 2))
      setMessage(ru ? 'Правило добавлено в черновик. Проверьте и сохраните его.' : 'Rule added to draft. Validate and save.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function submit(mode: 'validate' | 'save') {
    setError('')
    setMessage('')
    let config: PacingConfigDraft
    try { config = parse() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return }
    setBusy(mode)
    try {
      if (mode === 'validate') {
        const response = await apiFetch<{ valid: boolean }>('/api/settings/provider-pacing/validate', {
          method: 'POST', body: JSON.stringify({ config }),
        })
        setMessage(response.valid
          ? (ru ? 'Проверка пройдена. Включение пока недоступно.' : 'Validation passed. Activation is not yet available.')
          : (ru ? 'Неверное правило.' : 'Invalid rule.'))
      } else {
        const result = await apiFetch<SavedPacingDocument>('/api/settings/provider-pacing', {
          method: 'PUT', body: JSON.stringify({ revision, config }),
        })
        setRevision(result.revision)
        setDraft(JSON.stringify(result.config, null, 2))
        setMessage(ru ? 'Черновик сохранён. Очередь остаётся выключенной.' : 'Draft saved. Queue remains disabled.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(null) }
  }

  if (busy === 'load' && !draft) {
    return <p className="text-sm text-muted-foreground">{ru ? 'Загрузка настроек очереди…' : 'Loading queue settings…'}</p>
  }

  return (
    <section className="space-y-5">
      <div>
        <h2 className="font-heading text-base font-medium">{ru ? 'Provider Pacing & Queue' : 'Provider Pacing & Queue'}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {ru
            ? 'Черновики правил и диагностический статус. Отправка запросов через очередь будет доступна после сквозных испытаний.'
            : 'Draft rules and diagnostics. Queue activation requires completed end-to-end testing.'}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-lg border p-3 text-center text-xs">
        <div><p className="font-semibold">{runtime?.status.pending ?? '–'}</p><p className="text-muted-foreground">{ru ? 'Ожидают' : 'Pending'}</p></div>
        <div><p className="font-semibold">{runtime?.status.inflight ?? '–'}</p><p className="text-muted-foreground">{ru ? 'В работе' : 'In flight'}</p></div>
        <div><p className="font-semibold">{runtime?.enabled ? (ru ? 'Да' : 'Yes') : (ru ? 'Нет' : 'No')}</p><p className="text-muted-foreground">{ru ? 'Активна' : 'Active'}</p></div>
      </div>

      <fieldset disabled={busy !== null} className="space-y-3 rounded-lg border p-3">
        <legend className="px-1 text-xs font-semibold">{ru ? 'Добавить правило Pollinations' : 'Add a Pollinations rule'}</legend>
        <label className="block space-y-1 text-xs">
          <span>{ru ? 'Фактический modelId' : 'Actual modelId'}</span>
          <input value={modelId} onChange={e => setModelId(e.target.value)}
            placeholder={ru ? 'Укажите ID модели из маршрута' : 'Enter model ID from route'}
            className="w-full rounded-lg border border-input bg-transparent px-3 py-2 font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-xs">
            <span>keyId</span>
            <input value={keyId} onChange={e => setKeyId(e.target.value)} inputMode="numeric"
              placeholder="123" className="w-full rounded-lg border border-input bg-transparent px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </label>
          <label className="block space-y-1 text-xs">
            <span>{ru ? 'Интервал, мс' : 'Start interval, ms'}</span>
            <input value={intervalMs} onChange={e => setIntervalMs(e.target.value)} inputMode="numeric"
              className="w-full rounded-lg border border-input bg-transparent px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {ru ? 'Стартовый шаблон: 65 секунд между началами запросов, 1 одновременный запрос, ожидание до 180 секунд.' : 'Preset: 65s between starts, one concurrent call, maximum wait 180s.'}
        </p>
        <button type="button" onClick={addPollinationsRule}
          className="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-muted disabled:opacity-50">
          {ru ? 'Добавить в черновик' : 'Add to draft'}
        </button>
      </fieldset>

      <label className="block space-y-2 text-xs">
        <span className="font-semibold">{ru ? 'Конфигурация (JSON, ревизия ' : 'Policy JSON (revision '}{revision})</span>
        <textarea value={draft} onChange={e => setDraft(e.target.value)}
          spellCheck={false} rows={11}
          className="w-full resize-y rounded-lg border border-input bg-transparent p-3 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </label>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void submit('validate')} disabled={busy !== null || !draft}
          className="rounded-lg border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50">
          {busy === 'validate' ? '…' : ru ? 'Проверить' : 'Validate'}
        </button>
        <button type="button" onClick={() => void submit('save')} disabled={busy !== null || !draft}
          className="rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50">
          {busy === 'save' ? '…' : ru ? 'Сохранить черновик' : 'Save draft'}
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {ru
          ? 'Включение пока заблокировано сервером (pacing_not_ready). Ни один рабочий запрос не задерживается.'
          : 'Activation remains blocked server-side (pacing_not_ready). Live requests are unaffected.'}
      </p>
    </section>
  )
}
