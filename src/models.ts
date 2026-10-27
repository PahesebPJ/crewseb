import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type HostId, type ReasoningTier, SUPPORTED_HOSTS, SystemRuntime } from 'hubseb'
import { CREW_ROLES, type CrewRole } from './personas.ts'

export type ModelPresetName =
  | 'default'
  | 'lite'
  | 'hard'
  | 'hybrid'
  | 'ollama'
  | 'cloud-tiered'
  | 'custom'

export type ConcurrencyMode = 'parallel' | 'queue' | 'mixed'
export type OverflowTarget = 'lite' | 'any'

export interface CrewConcurrencyConfig {
  mode: ConcurrencyMode
  maxLocalParallel: number
  overflowTarget: OverflowTarget
}

export const DEFAULT_CONCURRENCY: CrewConcurrencyConfig = {
  mode: 'parallel',
  maxLocalParallel: 1,
  overflowTarget: 'lite',
}

export type HostTierModels = Partial<Record<ReasoningTier, string>>
export type RoleHostOverrides = Partial<Record<HostId | '*', string>>

export interface CrewModelsConfig {
  updatedAt: string
  preset: ModelPresetName
  tiers: Partial<Record<HostId, HostTierModels>>
  overrides: Partial<Record<CrewRole, RoleHostOverrides>>
  concurrency: CrewConcurrencyConfig
}

export const ROLE_TIERS: Record<CrewRole, ReasoningTier> = {
  researcher: 'balanced',
  analyst: 'balanced',
  architect: 'deep',
  developer: 'deep',
  'qa-automation': 'balanced',
  devops: 'balanced',
  sre: 'balanced',
  security: 'deep',
  'code-reviewer': 'deep',
  documenter: 'balanced',
}

const CLAUDE_TIER_DEFAULTS: Record<ReasoningTier, string> = {
  fast: 'haiku',
  balanced: 'sonnet',
  deep: 'opus',
}

const LITE_HOST_DEFAULTS: Record<HostId, string> = {
  antigravity: 'flash_lite',
  claude: 'haiku',
  codex: 'o4-mini',
  opencode: 'anthropic/claude-haiku-4-5',
}

const HARD_HOST_DEFAULTS: Record<HostId, string> = {
  antigravity: 'pro',
  claude: 'opus',
  codex: 'o3',
  opencode: 'anthropic/claude-opus-4-5',
}

export interface PresetBuildOptions {
  model?: string
  localModel?: string
  liteModel?: string
  fast?: string
  balanced?: string
  deep?: string
  hosts?: readonly HostId[]
  concurrency?: Partial<CrewConcurrencyConfig>
}

export function normalizeOllamaModel(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.includes('/') ? trimmed : `ollama/${trimmed}`
}

function normalizeConcurrency(raw?: Partial<CrewConcurrencyConfig>): CrewConcurrencyConfig {
  const mode: ConcurrencyMode =
    raw?.mode === 'parallel' || raw?.mode === 'queue' || raw?.mode === 'mixed'
      ? raw.mode
      : DEFAULT_CONCURRENCY.mode
  const maxLocalParallel =
    typeof raw?.maxLocalParallel === 'number' &&
    Number.isFinite(raw.maxLocalParallel) &&
    raw.maxLocalParallel >= 1
      ? Math.floor(raw.maxLocalParallel)
      : DEFAULT_CONCURRENCY.maxLocalParallel
  const overflowTarget: OverflowTarget =
    raw?.overflowTarget === 'lite' || raw?.overflowTarget === 'any'
      ? raw.overflowTarget
      : DEFAULT_CONCURRENCY.overflowTarget
  return { mode, maxLocalParallel, overflowTarget }
}

export function isLocalModelTag(modelTag?: string): boolean {
  if (!modelTag) return false
  const trimmed = modelTag.trim().toLowerCase()
  if (
    trimmed.startsWith('ollama/') ||
    trimmed.startsWith('lmstudio/') ||
    trimmed.startsWith('local/') ||
    trimmed.startsWith('llamacpp/')
  ) {
    return true
  }
  if (/^(?:qwen|deepseek-r1|llama\d|mistral|codellama|gemma|phi\d|starcoder)/i.test(trimmed)) {
    return true
  }
  return /:\d+(?:\.\d+)?b\b/i.test(trimmed)
}

export function hasLocalModels(config: CrewModelsConfig): {
  hasLocal: boolean
  primaryLocalModel?: string
} {
  const tierOrder: readonly ReasoningTier[] = ['fast', 'balanced', 'deep']
  const hostOrder: readonly HostId[] = ['opencode', 'codex', 'claude', 'antigravity']

  for (const tier of tierOrder) {
    for (const host of hostOrder) {
      const candidate = config.tiers?.[host]?.[tier]
      if (candidate && isLocalModelTag(candidate)) {
        return { hasLocal: true, primaryLocalModel: normalizeOllamaModel(candidate) }
      }
    }
  }

  for (const role of CREW_ROLES) {
    const roleMap = config.overrides?.[role]
    if (!roleMap) continue
    for (const key of ['*', ...hostOrder] as const) {
      const candidate = roleMap[key]
      if (candidate && isLocalModelTag(candidate)) {
        return { hasLocal: true, primaryLocalModel: normalizeOllamaModel(candidate) }
      }
    }
  }

  return { hasLocal: false }
}

export function buildPresetConfig(
  preset: Exclude<ModelPresetName, 'custom'> | 'custom',
  options?: PresetBuildOptions,
): CrewModelsConfig {
  const now = new Date().toISOString()
  const effectivePreset = preset === 'custom' ? 'hybrid' : preset

  if (effectivePreset === 'default') {
    return {
      updatedAt: now,
      preset: 'default',
      tiers: {},
      overrides: {},
      concurrency: normalizeConcurrency({
        mode: 'parallel',
        maxLocalParallel: 1,
        overflowTarget: 'lite',
        ...options?.concurrency,
      }),
    }
  }

  if (effectivePreset === 'lite') {
    const targetHosts: readonly HostId[] = options?.hosts ?? SUPPORTED_HOSTS
    const tiers: Partial<Record<HostId, HostTierModels>> = {}
    const customLite = options?.liteModel ?? options?.model
    for (const h of targetHosts) {
      const base = customLite ?? LITE_HOST_DEFAULTS[h]
      tiers[h] = {
        fast: options?.fast ?? base,
        balanced: options?.balanced ?? base,
        deep: options?.deep ?? base,
      }
    }
    return {
      updatedAt: now,
      preset: 'lite',
      tiers,
      overrides: {},
      concurrency: normalizeConcurrency({
        mode: 'parallel',
        maxLocalParallel: 1,
        overflowTarget: 'lite',
        ...options?.concurrency,
      }),
    }
  }

  if (effectivePreset === 'hard') {
    const targetHosts: readonly HostId[] = options?.hosts ?? SUPPORTED_HOSTS
    const tiers: Partial<Record<HostId, HostTierModels>> = {}
    for (const h of targetHosts) {
      const base = options?.model ?? HARD_HOST_DEFAULTS[h]
      tiers[h] = {
        fast: options?.fast ?? base,
        balanced: options?.balanced ?? base,
        deep: options?.deep ?? base,
      }
    }
    return {
      updatedAt: now,
      preset: 'hard',
      tiers,
      overrides: {},
      concurrency: normalizeConcurrency({
        mode: 'parallel',
        maxLocalParallel: 1,
        overflowTarget: 'any',
        ...options?.concurrency,
      }),
    }
  }

  if (effectivePreset === 'hybrid') {
    const localFast = normalizeOllamaModel(
      options?.fast ?? options?.localModel ?? options?.model ?? 'ollama/qwen2.5-coder:7b',
    )
    const localBalanced = normalizeOllamaModel(
      options?.balanced ?? options?.localModel ?? options?.model ?? 'ollama/qwen2.5-coder:7b',
    )
    const targetHosts: readonly HostId[] = options?.hosts ?? SUPPORTED_HOSTS
    const tiers: Partial<Record<HostId, HostTierModels>> = {}
    for (const h of targetHosts) {
      if (h === 'antigravity') {
        tiers.antigravity = {
          fast: 'flash_lite',
          balanced: 'flash_lite',
          deep: 'flash_lite',
        }
      } else {
        tiers[h] = {
          fast: localFast,
          balanced: localBalanced,
          deep: options?.deep ?? options?.liteModel ?? LITE_HOST_DEFAULTS[h],
        }
      }
    }
    return {
      updatedAt: now,
      preset: 'hybrid',
      tiers,
      overrides: {},
      concurrency: normalizeConcurrency({
        mode: 'mixed',
        maxLocalParallel: 1,
        overflowTarget: 'lite',
        ...options?.concurrency,
      }),
    }
  }

  if (effectivePreset === 'ollama') {
    const fast = normalizeOllamaModel(
      options?.fast ?? options?.localModel ?? options?.model ?? 'ollama/qwen2.5-coder:7b',
    )
    const balanced = normalizeOllamaModel(
      options?.balanced ?? options?.localModel ?? options?.model ?? 'ollama/qwen2.5-coder:14b',
    )
    const deep = normalizeOllamaModel(
      options?.deep ?? options?.localModel ?? options?.model ?? 'ollama/deepseek-r1:32b',
    )
    const targetHosts: readonly HostId[] = options?.hosts ?? ['opencode', 'codex', 'claude']
    const tiers: Partial<Record<HostId, HostTierModels>> = {}
    for (const h of targetHosts) {
      tiers[h] = { fast, balanced, deep }
    }
    return {
      updatedAt: now,
      preset: 'ollama',
      tiers,
      overrides: {},
      concurrency: normalizeConcurrency({
        mode: 'queue',
        maxLocalParallel: 1,
        overflowTarget: 'lite',
        ...options?.concurrency,
      }),
    }
  }

  const fullCloudTiers: Record<HostId, HostTierModels> = {
    antigravity: { fast: 'flash_lite', balanced: 'flash', deep: 'pro' },
    claude: { fast: 'haiku', balanced: 'sonnet', deep: 'opus' },
    codex: { fast: 'o4-mini', balanced: 'gpt-5.4', deep: 'o3' },
    opencode: {
      fast: 'anthropic/claude-haiku-4-5',
      balanced: 'anthropic/claude-sonnet-4-5',
      deep: 'anthropic/claude-opus-4-5',
    },
  }
  const targetHosts: readonly HostId[] = options?.hosts ?? SUPPORTED_HOSTS
  const tiers: Partial<Record<HostId, HostTierModels>> = {}
  for (const h of targetHosts) {
    tiers[h] = { ...fullCloudTiers[h] }
  }

  return {
    updatedAt: now,
    preset: 'cloud-tiered',
    tiers,
    overrides: {},
    concurrency: normalizeConcurrency({
      mode: 'parallel',
      maxLocalParallel: 1,
      overflowTarget: 'lite',
      ...options?.concurrency,
    }),
  }
}

export function resolveRoleModels(
  role: CrewRole,
  tier: ReasoningTier,
  config?: CrewModelsConfig,
): Partial<Record<HostId, string>> {
  if (!config) return {}
  const resolved: Partial<Record<HostId, string>> = {}
  const roleOverrides = config.overrides?.[role]

  for (const hostId of SUPPORTED_HOSTS) {
    const candidate =
      roleOverrides?.[hostId] ?? roleOverrides?.['*'] ?? config.tiers?.[hostId]?.[tier]
    if (candidate && candidate.trim().length > 0) {
      resolved[hostId] = candidate.trim()
    }
  }

  return resolved
}

export function effectiveDisplayModel(
  role: CrewRole,
  tier: ReasoningTier,
  hostId: HostId,
  config?: CrewModelsConfig,
): string {
  const explicit = resolveRoleModels(role, tier, config)[hostId]
  if (explicit) return explicit
  if (hostId === 'claude') return CLAUDE_TIER_DEFAULTS[tier]
  return 'inherit'
}

export function modelsFilePath(runtime: SystemRuntime = new SystemRuntime()): string {
  const override = runtime.env.CREWSEB_MODELS_FILE
  if (override && override.trim().length > 0) return path.resolve(override)
  return path.join(runtime.configRoot, 'crewseb-models.json')
}

const VALID_PRESETS = new Set<ModelPresetName>([
  'default',
  'lite',
  'hard',
  'hybrid',
  'ollama',
  'cloud-tiered',
  'custom',
])

export async function loadModelsConfig(
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<CrewModelsConfig> {
  const file = modelsFilePath(runtime)
  if (!existsSync(file)) {
    return buildPresetConfig('default')
  }
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<CrewModelsConfig>
    const preset: ModelPresetName =
      raw.preset && VALID_PRESETS.has(raw.preset) ? raw.preset : 'default'
    return {
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      preset,
      tiers: raw.tiers && typeof raw.tiers === 'object' ? raw.tiers : {},
      overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
      concurrency: normalizeConcurrency(raw.concurrency),
    }
  } catch {
    return buildPresetConfig('default')
  }
}

export async function saveModelsConfig(
  config: CrewModelsConfig,
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<string> {
  const file = modelsFilePath(runtime)
  await mkdir(path.dirname(file), { recursive: true })
  const payload: CrewModelsConfig = {
    ...config,
    concurrency: normalizeConcurrency(config.concurrency),
    updatedAt: new Date().toISOString(),
  }
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

export async function setRoleModel(
  role: CrewRole,
  model: string,
  host: HostId | '*' = '*',
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<{ config: CrewModelsConfig; file: string }> {
  const current = await loadModelsConfig(runtime)
  const roleOverrides: RoleHostOverrides = {
    ...(current.overrides[role] ?? {}),
    [host]: model.trim(),
  }
  const next: CrewModelsConfig = {
    updatedAt: new Date().toISOString(),
    preset: 'custom',
    tiers: { ...current.tiers },
    overrides: {
      ...current.overrides,
      [role]: roleOverrides,
    },
    concurrency: current.concurrency,
  }
  const file = await saveModelsConfig(next, runtime)
  return { config: next, file }
}

export async function setTierModel(
  tier: ReasoningTier,
  model: string,
  host: HostId | '*' = '*',
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<{ config: CrewModelsConfig; file: string }> {
  const current = await loadModelsConfig(runtime)
  const targetHosts: readonly HostId[] = host === '*' ? SUPPORTED_HOSTS : [host]
  const nextTiers: Partial<Record<HostId, HostTierModels>> = { ...current.tiers }
  for (const h of targetHosts) {
    nextTiers[h] = {
      ...(nextTiers[h] ?? {}),
      [tier]: model.trim(),
    }
  }
  const next: CrewModelsConfig = {
    updatedAt: new Date().toISOString(),
    preset: 'custom',
    tiers: nextTiers,
    overrides: { ...current.overrides },
    concurrency: current.concurrency,
  }
  const file = await saveModelsConfig(next, runtime)
  return { config: next, file }
}

export async function setConcurrencyConfig(
  patch: Partial<CrewConcurrencyConfig>,
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<{ config: CrewModelsConfig; file: string }> {
  const current = await loadModelsConfig(runtime)
  const next: CrewModelsConfig = {
    ...current,
    updatedAt: new Date().toISOString(),
    concurrency: normalizeConcurrency({
      ...current.concurrency,
      ...patch,
    }),
  }
  const file = await saveModelsConfig(next, runtime)
  return { config: next, file }
}

export async function applyModelPreset(
  preset: Exclude<ModelPresetName, 'custom'> | 'custom',
  options?: PresetBuildOptions,
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<{ config: CrewModelsConfig; file: string }> {
  const next = buildPresetConfig(preset, options)
  const file = await saveModelsConfig(next, runtime)
  return { config: next, file }
}

export async function resetModelsConfig(
  role?: CrewRole,
  host?: HostId | '*',
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<{ config: CrewModelsConfig; file: string }> {
  if (!role && (!host || host === '*')) {
    const fresh = buildPresetConfig('default')
    const file = await saveModelsConfig(fresh, runtime)
    return { config: fresh, file }
  }

  const current = await loadModelsConfig(runtime)
  const nextTiers: Partial<Record<HostId, HostTierModels>> = { ...current.tiers }
  const nextOverrides: Partial<Record<CrewRole, RoleHostOverrides>> = { ...current.overrides }

  if (role) {
    if (host && host !== '*') {
      const existing = { ...(nextOverrides[role] ?? {}) }
      delete existing[host]
      if (Object.keys(existing).length > 0) {
        nextOverrides[role] = existing
      } else {
        delete nextOverrides[role]
      }
    } else {
      delete nextOverrides[role]
    }
  } else if (host && host !== '*') {
    delete nextTiers[host]
    for (const r of CREW_ROLES) {
      if (nextOverrides[r]?.[host]) {
        const existing = { ...nextOverrides[r] }
        delete existing[host]
        if (Object.keys(existing).length > 0) {
          nextOverrides[r] = existing
        } else {
          delete nextOverrides[r]
        }
      }
    }
  }

  const hasAny = Object.keys(nextTiers).length > 0 || Object.keys(nextOverrides).length > 0
  const next: CrewModelsConfig = {
    updatedAt: new Date().toISOString(),
    preset: hasAny ? current.preset : 'default',
    tiers: nextTiers,
    overrides: nextOverrides,
    concurrency: hasAny ? current.concurrency : DEFAULT_CONCURRENCY,
  }
  const file = await saveModelsConfig(next, runtime)
  return { config: next, file }
}
