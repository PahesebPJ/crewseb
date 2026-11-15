import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AGY_MODEL_TIERS, EFFORT_LEVELS, type EffortLevel, type HostId, isEffortLevel, SystemRuntime } from 'hubseb'

export interface CatalogModel {
  /** Id passed to the host (`--model` / frontmatter). For agy this is the base, without effort suffix. */
  id: string
  label: string
  efforts: EffortLevel[]
  /** True for agy tier aliases, which are the only values its agent frontmatter accepts. */
  nativeTier?: boolean
}

export interface ModelCatalog {
  host: HostId
  source: 'live' | 'cache' | 'builtin'
  fetchedAt: string | null
  models: CatalogModel[]
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SUFFIX = new RegExp(`^(.+)-(${EFFORT_LEVELS.join('|')})$`)

/** Splits "gemini-4-hydrogen-xhigh" into { base: "gemini-4-hydrogen", effort: "xhigh" }. */
export function splitEffortSuffix(id: string): { base: string; effort: EffortLevel | null } {
  const m = SUFFIX.exec(id)
  if (m && isEffortLevel(m[2])) return { base: m[1] as string, effort: m[2] }
  return { base: id, effort: null }
}

function stripLabelEffort(label: string): string {
  return label.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, '').trim()
}

/** Parses `agy models` output ("<id>\t<label>" lines) grouping effort variants by base id. */
export function parseAgyModels(output: string): CatalogModel[] {
  const byBase = new Map<string, CatalogModel>()
  for (const line of output.split('\n')) {
    const [rawId, ...rest] = line.split('\t')
    const id = rawId?.trim() ?? ''
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) continue
    const { base, effort } = splitEffortSuffix(id)
    const label = stripLabelEffort(rest.join('\t').trim() || base)
    const entry = byBase.get(base) ?? { id: base, label, efforts: [] }
    if (effort && !entry.efforts.includes(effort)) entry.efforts.push(effort)
    byBase.set(base, entry)
  }
  for (const m of byBase.values()) m.efforts.sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b))
  return [...byBase.values()]
}

const AGY_TIER_MODELS: CatalogModel[] = AGY_MODEL_TIERS.map((t) => ({
  id: t,
  label: `Tier nativo ${t}`,
  efforts: [],
  nativeTier: true,
}))

const ALL_EFFORTS = [...EFFORT_LEVELS]

const CLAUDE_MODELS: CatalogModel[] = [
  { id: 'opus', label: 'Opus (alias, última versión)', efforts: ALL_EFFORTS },
  { id: 'sonnet', label: 'Sonnet (alias, última versión)', efforts: ALL_EFFORTS },
  { id: 'haiku', label: 'Haiku (alias, última versión)', efforts: ALL_EFFORTS },
  { id: 'fable', label: 'Fable (alias, última versión)', efforts: ALL_EFFORTS },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ALL_EFFORTS },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts: ALL_EFFORTS },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', efforts: ALL_EFFORTS },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', efforts: ALL_EFFORTS },
]

export function catalogCacheFile(runtime: SystemRuntime, host: HostId): string {
  return path.join(runtime.stateRoot, 'cache', `models-${host}.json`)
}

export interface CatalogOptions {
  refresh?: boolean
  now?: () => number
  /** Injected for tests; defaults to running `agy models`. */
  fetchAgy?: () => Promise<string | null>
}

async function defaultFetchAgy(runtime: SystemRuntime): Promise<string | null> {
  const exe = runtime.locateBinary('agy', [path.join(runtime.homeDir, '.gemini', 'antigravity-cli', 'bin')])
  if (!exe) return null
  try {
    const res = await runtime.execProcess(exe, ['models'], { timeoutMs: 30_000 })
    return res.exitCode === 0 ? res.stdout : null
  } catch {
    return null
  }
}

/** Lists the models a host offers. agy is discovered live (cached 24h) so new models appear on their own. */
export async function loadCatalog(
  host: HostId,
  runtime: SystemRuntime = new SystemRuntime(),
  opts: CatalogOptions = {},
): Promise<ModelCatalog> {
  if (host === 'claude') return { host, source: 'builtin', fetchedAt: null, models: CLAUDE_MODELS }
  if (host !== 'antigravity') return { host, source: 'builtin', fetchedAt: null, models: [] }

  const now = opts.now ?? Date.now
  const file = catalogCacheFile(runtime, host)
  let cached: ModelCatalog | null = null
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as ModelCatalog
      if (Array.isArray(raw.models) && typeof raw.fetchedAt === 'string') cached = raw
    } catch {
      cached = null
    }
  }
  const fresh = cached?.fetchedAt && now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS
  if (cached && fresh && !opts.refresh) return { ...cached, source: 'cache', models: [...AGY_TIER_MODELS, ...cached.models.filter((m) => !m.nativeTier)] }

  const output = await (opts.fetchAgy ?? (() => defaultFetchAgy(runtime)))()
  const live = output ? parseAgyModels(output) : []
  if (live.length === 0) {
    // Offline or agy missing: fall back to the stale cache, then to the tiers alone.
    if (cached) return { ...cached, source: 'cache', models: [...AGY_TIER_MODELS, ...cached.models.filter((m) => !m.nativeTier)] }
    return { host, source: 'builtin', fetchedAt: null, models: AGY_TIER_MODELS }
  }
  const catalog: ModelCatalog = { host, source: 'live', fetchedAt: new Date(now()).toISOString(), models: live }
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return { ...catalog, models: [...AGY_TIER_MODELS, ...live] }
}

export interface ModelCheck {
  known: boolean
  effortSupported: boolean
  warning: string | null
}

/** Soft validation: unknown models only warn (the catalog may be stale or the host offline). */
export function checkModel(catalog: ModelCatalog, model: string, effort?: EffortLevel | null): ModelCheck {
  const { base, effort: suffix } = splitEffortSuffix(model)
  const entry = catalog.models.find((m) => m.id === model) ?? catalog.models.find((m) => m.id === base)
  if (!entry) {
    return catalog.models.length === 0
      ? { known: false, effortSupported: true, warning: null }
      : { known: false, effortSupported: true, warning: `"${model}" no está en el catálogo de ${catalog.host}; se guarda igual.` }
  }
  if (suffix && effort && suffix !== effort) {
    return { known: true, effortSupported: false, warning: `"${model}" ya fija el esfuerzo ${suffix}; usa el modelo base "${base}" con --effort ${effort}.` }
  }
  if (effort && entry.efforts.length > 0 && !entry.efforts.includes(effort)) {
    return { known: true, effortSupported: false, warning: `${entry.label} no ofrece esfuerzo ${effort} (disponibles: ${entry.efforts.join(', ')}).` }
  }
  if (effort && entry.nativeTier) {
    return { known: true, effortSupported: false, warning: `El tier ${entry.id} no admite esfuerzo; elige un modelo concreto (p. ej. gemini-4-hydrogen).` }
  }
  return { known: true, effortSupported: true, warning: null }
}
