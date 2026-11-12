import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SystemRuntime } from 'hubseb'
import { CREW_ROLES, type CrewRole } from './personas.ts'

export const DEFAULT_ROLE_LIMITS: Record<CrewRole, number> = {
  researcher: 35,
  analyst: 30,
  architect: 35,
  developer: 80,
  'qa-automation': 60,
  devops: 60,
  sre: 40,
  security: 40,
  'code-reviewer': 35,
  documenter: 40,
}

export const GLOBAL_DEFAULT_MAX_STEPS = 50

export interface CrewLimitsConfig {
  updatedAt: string
  defaultMaxSteps: number
  roles: Partial<Record<CrewRole, number>>
}

export function defaultLimitsConfig(): CrewLimitsConfig {
  return {
    updatedAt: new Date().toISOString(),
    defaultMaxSteps: GLOBAL_DEFAULT_MAX_STEPS,
    roles: { ...DEFAULT_ROLE_LIMITS },
  }
}

export function limitsFilePath(runtime: SystemRuntime = new SystemRuntime()): string {
  const override = runtime.env.CREWSEB_LIMITS_FILE
  if (override && override.trim().length > 0) return path.resolve(override)
  return path.join(runtime.configRoot, 'crewseb-limits.json')
}

export async function loadLimitsConfig(
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<CrewLimitsConfig> {
  const file = limitsFilePath(runtime)
  if (!existsSync(file)) {
    return defaultLimitsConfig()
  }
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CrewLimitsConfig>
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      defaultMaxSteps:
        typeof parsed.defaultMaxSteps === 'number' && parsed.defaultMaxSteps > 0
          ? parsed.defaultMaxSteps
          : GLOBAL_DEFAULT_MAX_STEPS,
      roles:
        parsed.roles && typeof parsed.roles === 'object'
          ? { ...DEFAULT_ROLE_LIMITS, ...parsed.roles }
          : { ...DEFAULT_ROLE_LIMITS },
    }
  } catch {
    return defaultLimitsConfig()
  }
}

export async function saveLimitsConfig(
  config: CrewLimitsConfig,
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<void> {
  const file = limitsFilePath(runtime)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export async function setRoleLimit(
  target: CrewRole | 'all' | 'default',
  maxSteps: number,
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<CrewLimitsConfig> {
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new Error(`Invalid maxSteps: ${maxSteps}. Must be a positive integer.`)
  }

  const config = await loadLimitsConfig(runtime)
  config.updatedAt = new Date().toISOString()

  if (target === 'all') {
    config.defaultMaxSteps = maxSteps
    for (const role of CREW_ROLES) {
      config.roles[role] = maxSteps
    }
  } else if (target === 'default') {
    config.defaultMaxSteps = maxSteps
  } else if (CREW_ROLES.includes(target)) {
    config.roles[target] = maxSteps
  } else {
    throw new Error(`Unknown role or target "${target}". Valid roles: ${CREW_ROLES.join(', ')}`)
  }

  await saveLimitsConfig(config, runtime)
  return config
}

export async function resetLimitsConfig(
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<CrewLimitsConfig> {
  const config = defaultLimitsConfig()
  await saveLimitsConfig(config, runtime)
  return config
}

export function resolveRoleMaxSteps(
  role: CrewRole,
  limitsConfig?: CrewLimitsConfig,
): number {
  if (!limitsConfig) return DEFAULT_ROLE_LIMITS[role] ?? GLOBAL_DEFAULT_MAX_STEPS
  return limitsConfig.roles[role] ?? limitsConfig.defaultMaxSteps ?? DEFAULT_ROLE_LIMITS[role] ?? GLOBAL_DEFAULT_MAX_STEPS
}
