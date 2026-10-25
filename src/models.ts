import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type HostId, type ReasoningTier, SUPPORTED_HOSTS, SystemRuntime } from 'hubseb'
import { CREW_ROLES, type CrewRole } from './personas.ts'

export type ModelPresetName = 'default' | 'ollama' | 'cloud-tiered' | 'custom'
export type HostTierModels = Partial<Record<ReasoningTier, string>>
export type RoleHostOverrides = Partial<Record<HostId | '*', string>>

export interface CrewModelsConfig {
  updatedAt: string
  preset: ModelPresetName
  tiers: Partial<Record<HostId, HostTierModels>>
  overrides: Partial<Record<CrewRole, RoleHostOverrides>>
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

export interface PresetBuildOptions {
  model?: string
  fast?: string
  balanced?: string
  deep?: string
  hosts?: readonly HostId[]
}

function normalizeOllamaModel(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.includes('/') ? trimmed : `ollama/${trimmed}`
}

export function buildPresetConfig(
  preset: 'default' | 'ollama' | 'cloud-tiered',
  options?: PresetBuildOptions,
): CrewModelsConfig {
  const now = new Date().toISOString()

  if (preset === 'default') {
    return {
      updatedAt: now,
      preset: 'default',
      tiers: {},
      overrides: {},
    }
  }

  if (preset === 'ollama') {
    const fast = normalizeOllamaModel(options?.fast ?? options?.model ?? 'ollama/qwen2.5-coder:7b')
    const balanced = normalizeOllamaModel(
      options?.balanced ?? options?.model ?? 'ollama/qwen2.5-coder:14b',
    )
    const deep = normalizeOllamaModel(options?.deep ?? options?.model ?? 'ollama/deepseek-r1:32b')
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
      raw.preset === 'default' ||
      raw.preset === 'ollama' ||
      raw.preset === 'cloud-tiered' ||
      raw.preset === 'custom'
        ? raw.preset
        : 'default'
    return {
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      preset,
      tiers: raw.tiers && typeof raw.tiers === 'object' ? raw.tiers : {},
      overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
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
  }
  const file = await saveModelsConfig(next, runtime)
  return { config: next, file }
}

export async function applyModelPreset(
  preset: 'default' | 'ollama' | 'cloud-tiered',
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
  }
  const file = await saveModelsConfig(next, runtime)
  return { config: next, file }
}
