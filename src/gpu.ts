import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { SystemRuntime } from 'hubseb'

const execFileAsync = promisify(execFile)

export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'unknown'

export interface GpuDeviceInfo {
  detected: boolean
  vendor: GpuVendor
  name: string
  vramMb: number
  freeVramMb: number
  source: 'env' | 'nvidia-smi' | 'rocm-smi' | 'sysfs' | 'system_profiler' | 'fallback'
}

export interface VramCapacityAssessment {
  gpu: GpuDeviceInfo
  modelTag: string
  weightsMb: number
  kvSlotMb: number
  availableVramMb: number
  maxConcurrentAgents: number
  recommendedMode: 'parallel' | 'queue' | 'mixed'
  summary: string
}

export interface VramValidationResult {
  allowed: boolean
  forced: boolean
  requestedParallel: number
  maxSupportedParallel: number
  assessment: VramCapacityAssessment
  reason?: string
}

export async function detectGpu(
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<GpuDeviceInfo> {
  const envVram = runtime.env.CREWSEB_GPU_VRAM_MB
  if (envVram !== undefined && envVram.trim() !== '') {
    const vramMb = Math.max(0, Math.floor(Number(envVram)) || 0)
    const envFree = runtime.env.CREWSEB_GPU_FREE_VRAM_MB
    const freeVramMb =
      envFree !== undefined && envFree.trim() !== ''
        ? Math.max(0, Math.floor(Number(envFree)) || 0)
        : vramMb
    const vendor = (runtime.env.CREWSEB_GPU_VENDOR as GpuVendor | undefined) ?? 'nvidia'
    const name = runtime.env.CREWSEB_GPU_NAME ?? 'Simulated GPU'
    return {
      detected: vramMb > 0,
      vendor,
      name,
      vramMb,
      freeVramMb,
      source: 'env',
    }
  }

  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 2500 },
    )
    const firstLine = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    if (firstLine) {
      const parts = firstLine.split(',').map((p) => p.trim())
      const name = parts[0] || 'NVIDIA GPU'
      const vramMb = Math.floor(Number(parts[1]))
      const freeVramMb = Math.floor(Number(parts[2]))
      if (Number.isFinite(vramMb) && vramMb > 0) {
        return {
          detected: true,
          vendor: 'nvidia',
          name,
          vramMb,
          freeVramMb: Number.isFinite(freeVramMb) && freeVramMb >= 0 ? freeVramMb : vramMb,
          source: 'nvidia-smi',
        }
      }
    }
  } catch {
    // Fall through to next detection method
  }

  if (process.platform === 'linux') {
    try {
      const drmDir = '/sys/class/drm'
      if (existsSync(drmDir)) {
        const entries = await readdir(drmDir)
        for (const entry of entries) {
          if (!/^card\d+$/.test(entry)) continue
          const totalFile = path.join(drmDir, entry, 'device', 'mem_info_vram_total')
          if (!existsSync(totalFile)) continue
          const rawTotal = await readFile(totalFile, 'utf8')
          const totalBytes = Number(rawTotal.trim())
          if (Number.isFinite(totalBytes) && totalBytes > 0) {
            const vramMb = Math.floor(totalBytes / (1024 * 1024))
            let freeVramMb = vramMb
            const usedFile = path.join(drmDir, entry, 'device', 'mem_info_vram_used')
            if (existsSync(usedFile)) {
              const rawUsed = await readFile(usedFile, 'utf8')
              const usedBytes = Number(rawUsed.trim())
              if (Number.isFinite(usedBytes) && usedBytes >= 0) {
                freeVramMb = Math.max(0, vramMb - Math.floor(usedBytes / (1024 * 1024)))
              }
            }
            return {
              detected: true,
              vendor: 'amd',
              name: 'AMD Radeon GPU (sysfs)',
              vramMb,
              freeVramMb,
              source: 'sysfs',
            }
          }
        }
      }
    } catch {
      // Fall through
    }

    try {
      const { stdout } = await execFileAsync('rocm-smi', ['--showmeminfo', 'vram', '--csv'], {
        timeout: 2500,
      })
      const match = /(\d+)\s*,\s*(\d+)/.exec(stdout)
      if (match) {
        const totalBytes = Number(match[1])
        const usedBytes = Number(match[2])
        if (Number.isFinite(totalBytes) && totalBytes > 0) {
          const vramMb = Math.floor(totalBytes / (1024 * 1024))
          const usedMb = Number.isFinite(usedBytes) ? Math.floor(usedBytes / (1024 * 1024)) : 0
          return {
            detected: true,
            vendor: 'amd',
            name: 'AMD ROCm GPU',
            vramMb,
            freeVramMb: Math.max(0, vramMb - usedMb),
            source: 'rocm-smi',
          }
        }
      }
    } catch {
      // Fall through
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.memsize'], { timeout: 2500 })
      const totalBytes = Number(stdout.trim())
      if (Number.isFinite(totalBytes) && totalBytes > 0) {
        const vramMb = Math.floor((totalBytes / (1024 * 1024)) * 0.7)
        return {
          detected: true,
          vendor: 'apple',
          name: 'Apple Unified Memory GPU',
          vramMb,
          freeVramMb: vramMb,
          source: 'system_profiler',
        }
      }
    } catch {
      // Fall through
    }
  }

  return {
    detected: false,
    vendor: 'unknown',
    name: 'No dedicated GPU detected (CPU/RAM only)',
    vramMb: 0,
    freeVramMb: 0,
    source: 'fallback',
  }
}

export function estimateModelVramMb(modelTag: string): { weightsMb: number; kvSlotMb: number } {
  const colonMatch = /:(\d+(?:\.\d+)?)\s*[bB]\b/.exec(modelTag)
  const genericMatch = /(?:[:_-]|^)(\d+(?:\.\d+)?)\s*[bB]\b/.exec(modelTag)
  const rawParams = colonMatch?.[1] ?? genericMatch?.[1]
  const paramsB = rawParams ? Number(rawParams) : 7

  if (paramsB <= 3) {
    return { weightsMb: 2200, kvSlotMb: 600 }
  }
  if (paramsB <= 8) {
    return { weightsMb: 4500, kvSlotMb: 1000 }
  }
  if (paramsB <= 14) {
    return { weightsMb: 9000, kvSlotMb: 1500 }
  }
  if (paramsB <= 34) {
    return { weightsMb: 19500, kvSlotMb: 2500 }
  }
  return { weightsMb: 42000, kvSlotMb: 4000 }
}

export function assessVramCapacity(
  gpu: GpuDeviceInfo,
  modelTag: string = 'ollama/qwen2.5-coder:7b',
): VramCapacityAssessment {
  const { weightsMb, kvSlotMb } = estimateModelVramMb(modelTag)
  const availableVramMb = gpu.vramMb
  const minRequiredMb = weightsMb + kvSlotMb
  const maxConcurrentAgents =
    availableVramMb < minRequiredMb
      ? 0
      : 1 + Math.floor((availableVramMb - minRequiredMb) / kvSlotMb)

  const recommendedMode: 'parallel' | 'queue' | 'mixed' =
    maxConcurrentAgents <= 1 ? 'queue' : maxConcurrentAgents <= 3 ? 'mixed' : 'parallel'

  const summary = gpu.detected
    ? `${gpu.name} (${gpu.vramMb} MB VRAM) soporta hasta ${maxConcurrentAgents} subagente(s) simultáneo(s) con "${modelTag}" (~${weightsMb} MB base + ~${kvSlotMb} MB/agente). Modo recomendado: ${recommendedMode}.`
    : `Sin GPU dedicada detectada (0 MB VRAM). El modelo "${modelTag}" (~${weightsMb} MB base + ~${kvSlotMb} MB/agente) no cabe en VRAM dedicada. Modo recomendado: ${recommendedMode}.`

  return {
    gpu,
    modelTag,
    weightsMb,
    kvSlotMb,
    availableVramMb,
    maxConcurrentAgents,
    recommendedMode,
    summary,
  }
}

export function validateLocalConcurrency(params: {
  gpu: GpuDeviceInfo
  requestedParallel: number
  modelTag?: string
  force?: boolean
}): VramValidationResult {
  const assessment = assessVramCapacity(params.gpu, params.modelTag ?? 'ollama/qwen2.5-coder:7b')
  const exceeds = params.requestedParallel > assessment.maxConcurrentAgents
  const forced = Boolean(params.force)
  const allowed = !exceeds || forced
  const safeMax = Math.max(1, assessment.maxConcurrentAgents)

  const reason = exceeds
    ? `⚠️ Límite de VRAM excedido en ${params.gpu.name} (${params.gpu.vramMb} MB VRAM): el modelo "${assessment.modelTag}" requiere ~${assessment.weightsMb} MB base + ~${assessment.kvSlotMb} MB por agente activo. Tu gráfica soporta máximo ${assessment.maxConcurrentAgents} agente(s) local(es) simultáneo(s), pero solicitaste ${params.requestedParallel}. Usa "--mode queue" (cola secuencial), "--mode mixed --max-local ${safeMax}" (mixto con agentes lite) o ajusta "--max-local ${safeMax}".`
    : undefined

  return {
    allowed,
    forced,
    requestedParallel: params.requestedParallel,
    maxSupportedParallel: assessment.maxConcurrentAgents,
    assessment,
    ...(reason ? { reason } : {}),
  }
}
