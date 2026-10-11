import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

interface TimeoutValue {
  platform: string
  modelId?: string
  name?: string
  timeoutMs: number
  defaultMs: number
  source: 'environment' | 'provider_default' | 'dashboard_provider' | 'dashboard_model'
  providerOverrideMs: number | null
  modelOverrideMs: number | null
  envName: string
  firstByteTimeoutMs: number
  streamStallTimeoutMs: number
}

export function ProviderTimeoutEditor({ open, ru }: { open: boolean; ru: boolean }) {
  const [providers, setProviders] = useState<TimeoutValue[]>([])
  const [platform, setPlatform] = useState('pollinations')
  const [modelId, setModelId] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('120000')
  const [effective, setEffective] = useState<TimeoutValue | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let mounted = true
    apiFetch<{ providers: TimeoutValue[] }>('/api/settings/provider-timeouts')
      .then(result => {
        if (!mounted) return
        setProviders(result.providers)
        const selected = result.providers.find(item => item.platform === platform)
          ?? result.providers[0]
        if (selected) {
          setPlatform(selected.platform)
          setEffective(selected)
          setTimeoutMs(String(selected.timeoutMs))
        }
      })
      .catch(err => { if (mounted) setError(err instanceof Error ? err.message : String(err)) })
    return () => { mounted = false }
  }, [open])

  async function readCurrent(selectedPlatform = platform, selectedModel = modelId) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const params = new URLSearchParams({ platform: selectedPlatform })
      if (selectedModel.trim()) params.set('modelId', selectedModel.trim())
      const response = await apiFetch<{ provider: TimeoutValue }>(
        '/api/settings/provider-timeouts?' + params.toString(),
      )
      setEffective(response.provider)
      setTimeoutMs(String(response.provider.timeoutMs))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function save(reset: boolean) {
    setMessage('')
    setError('')
    const millis = Number(timeoutMs)
    if (!reset && (!Number.isSafeInteger(millis) || millis < 1000 || millis > 900000)) {
      setError(ru ? 'Введите целое значение от 1000 до 900000 мс.' : 'Enter 1000–900000 milliseconds.')
      return
    }
    setBusy(true)
    try {
      const response = await apiFetch<{ provider: TimeoutValue }>('/api/settings/provider-timeouts', {
        method: 'PUT',
        body: JSON.stringify({
          platform,
          ...(modelId.trim() ? { modelId: modelId.trim() } : {}),
          timeoutMs: reset ? null : millis,
        }),
      })
      setEffective(response.provider)
      setTimeoutMs(String(response.provider.timeoutMs))
      setMessage(reset
        ? (ru ? 'Переопределение сброшено. Применяется следующий уровень настроек.' : 'Override reset; next priority level applies.')
        : (ru ? 'Сохранено. Новое значение действует для следующих вызовов.' : 'Saved. Applies to subsequent calls.'))
      const updated = await apiFetch<{ providers: TimeoutValue[] }>('/api/settings/provider-timeouts')
      setProviders(updated.providers)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset disabled={busy} className="space-y-3 rounded-lg border p-3">
      <legend className="px-1 text-xs font-semibold">
        {ru ? 'Ручная настройка тайм-аута модели или провайдера' : 'Manual model/provider timeouts'}
      </legend>
      <p className="text-[11px] text-muted-foreground">
        {ru
          ? 'Эти значения НЕ изменяют лимит RPM или интервал очереди. Настройка применяется к новому upstream-запросу без перезапуска.'
          : 'This does NOT change RPM or queue pacing. New upstream attempts use the saved value without a restart.'}
      </p>
      <label className="block space-y-1 text-xs">
        <span>{ru ? 'Провайдер' : 'Provider'}</span>
        <select value={platform} onChange={event => {
          const selected = event.target.value
          setPlatform(selected)
          setModelId('')
          const doc = providers.find(x => x.platform === selected)
          if (doc) { setEffective(doc); setTimeoutMs(String(doc.timeoutMs)) }
          setMessage('')
          setError('')
        }} className="w-full rounded-lg border border-input bg-background px-3 py-2">
          {providers.map(p => <option key={p.platform} value={p.platform}>
            {p.name ?? p.platform} ({p.platform})
          </option>)}
        </select>
      </label>
      <label className="block space-y-1 text-xs">
        <span>{ru ? 'Модель (необязательно)' : 'Model (optional)'}</span>
        <input value={modelId} onChange={e => setModelId(e.target.value)}
          placeholder={ru ? 'Пусто = весь провайдер' : 'Empty = entire provider'}
          className="w-full rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs" />
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-32 flex-1 space-y-1 text-xs">
          <span>{ru ? 'Ожидание ответа, мс' : 'Upstream timeout, ms'}</span>
          <input inputMode="numeric" value={timeoutMs} onChange={e => setTimeoutMs(e.target.value)}
            className="w-full rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs" />
        </label>
        <button type="button" onClick={() => void readCurrent()}
          className="rounded-lg border px-3 py-2 text-xs hover:bg-muted">
          {ru ? 'Проверить текущее' : 'Load effective'}
        </button>
      </div>
      {effective && <div className="text-[11px] text-muted-foreground">
        <p>{ru ? 'Эффективно' : 'Effective'}: {effective.timeoutMs} ms
          {' | '}{ru ? 'Источник' : 'Source'}: <strong>{effective.source}</strong>
        </p>
        <p>{ru ? 'Первый SSE-байт' : 'First SSE byte'}: {effective.firstByteTimeoutMs} ms
          {' | '}{ru ? 'Пауза SSE' : 'SSE stall'}: {effective.streamStallTimeoutMs} ms</p>
        <p>{ru ? 'Сохранено для провайдера' : 'Saved provider'}:
          {' '}{effective.providerOverrideMs ?? '—'} ms
          {' | '}{ru ? 'для модели' : 'model'}: {effective.modelOverrideMs ?? '—'} ms</p>
      </div>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void save(false)}
          className="rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background">
          {ru ? 'Сохранить тайм-аут' : 'Save timeout'}
        </button>
        <button type="button" onClick={() => void save(true)}
          className="rounded-lg border px-3 py-2 text-xs hover:bg-muted">
          {ru ? 'Сбросить переопределение' : 'Reset override'}
        </button>
      </div>
      {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </fieldset>
  )
}
