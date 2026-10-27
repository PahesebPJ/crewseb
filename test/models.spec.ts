import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { SUPPORTED_HOSTS, SystemRuntime } from 'hubseb'
import { executeCrewCli } from '../src/bin/crewseb.ts'
import { buildAgents, renderSkillMarkdown, SKILL_DIR, writeAgents } from '../src/build.ts'
import { assessVramCapacity, detectGpu, estimateModelVramMb, validateLocalConcurrency } from '../src/gpu.ts'
import {
  applyModelPreset,
  buildPresetConfig,
  effectiveDisplayModel,
  loadModelsConfig,
  resolveRoleModels,
  ROLE_TIERS,
  setConcurrencyConfig,
  setRoleModel,
  setTierModel,
} from '../src/models.ts'
import { DEFAULT_PERSONAS, savePersonas } from '../src/personas.ts'
import { deployCrewseb, syncModelsAndDeploy } from '../src/setup.ts'

function createIsolatedEnv(tmpDir: string, extraEnv: Record<string, string> = {}) {
  const runtime = new SystemRuntime({
    homeDir: tmpDir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
      HUBSEB_HOME: path.join(tmpDir, '.hubseb'),
      CREWSEB_MODELS_FILE: path.join(tmpDir, 'crewseb-models.json'),
      CREWSEB_PERSONAS_FILE: path.join(tmpDir, 'personas.json'),
      ...extraEnv,
    },
  })

  const roots = {
    antigravity: path.join(tmpDir, '.gemini', 'config'),
    claude: path.join(tmpDir, '.claude'),
    codex: path.join(tmpDir, '.codex'),
    opencode: path.join(tmpDir, '.config', 'opencode'),
  }

  return { runtime, roots }
}

describe('crewseb custom and local (Ollama) models engine & CLI', () => {
  it('applies the ollama preset and compiles multi-host agent files with provider-aware model formats', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-models-ollama-'))
    try {
      const { runtime, roots } = createIsolatedEnv(tmpDir)
      await savePersonas(DEFAULT_PERSONAS, runtime)

      const { config } = await applyModelPreset('ollama', undefined, runtime)
      assert.equal(config.preset, 'ollama')

      await deployCrewseb({
        runtime,
        roots,
        hosts: SUPPORTED_HOSTS,
      })

      // OpenCode: retains full provider/model format
      const opencodeDev = await readFile(
        path.join(roots.opencode, 'agents', 'developer.md'),
        'utf8',
      )
      const opencodeRes = await readFile(
        path.join(roots.opencode, 'agents', 'researcher.md'),
        'utf8',
      )
      assert.match(opencodeDev, /^model:\s*ollama\/deepseek-r1:32b$/m)
      assert.match(opencodeRes, /^model:\s*ollama\/qwen2\.5-coder:14b$/m)

      // Codex: splits ollama/<tag> into model and model_provider = "ollama"
      const codexDev = await readFile(
        path.join(roots.codex, 'agents', 'developer.toml'),
        'utf8',
      )
      assert.match(codexDev, /^model = "deepseek-r1:32b"$/m)
      assert.match(codexDev, /^model_provider = "ollama"$/m)

      // Claude: strips ollama/ prefix for local gateway compatibility
      const claudeDev = await readFile(
        path.join(roots.claude, 'agents', 'developer.md'),
        'utf8',
      )
      assert.match(claudeDev, /^model:\s*deepseek-r1:32b$/m)

      // Antigravity: remains inherit by default on ollama preset unless explicitly overridden
      const agyDev = await readFile(
        path.join(roots.antigravity, 'plugins', 'crewseb', 'agents', 'developer.md'),
        'utf8',
      )
      assert.match(agyDev, /^model:\s*inherit$/m)

      // Verify Antigravity accepts explicit model override (e.g. pro)
      const { config: withAgyPro } = await setRoleModel('developer', 'pro', 'antigravity', runtime)
      await syncModelsAndDeploy(withAgyPro, { runtime, roots, hosts: ['antigravity'] })
      const agyDevPro = await readFile(
        path.join(roots.antigravity, 'plugins', 'crewseb', 'agents', 'developer.md'),
        'utf8',
      )
      assert.match(agyDevPro, /^model:\s*pro$/m)
    } finally {
      await writeAgents(await buildAgents(DEFAULT_PERSONAS))
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('builds and compiles lite, hard, and hybrid (plus custom alias) presets across all 4 hosts', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-models-presets-'))
    try {
      const { runtime, roots } = createIsolatedEnv(tmpDir, {
        CREWSEB_GPU_VRAM_MB: '8192',
        CREWSEB_GPU_NAME: 'Simulated RTX 4060',
      })
      await savePersonas(DEFAULT_PERSONAS, runtime)

      // 1. Preset 'lite': lightweight models across all 4 hosts and all tiers
      const liteConfig = buildPresetConfig('lite')
      assert.equal(liteConfig.preset, 'lite')
      assert.equal(liteConfig.concurrency.mode, 'parallel')
      assert.deepEqual(liteConfig.tiers.antigravity, {
        fast: 'flash_lite',
        balanced: 'flash_lite',
        deep: 'flash_lite',
      })
      assert.deepEqual(liteConfig.tiers.claude, {
        fast: 'haiku',
        balanced: 'haiku',
        deep: 'haiku',
      })
      assert.deepEqual(liteConfig.tiers.codex, {
        fast: 'o4-mini',
        balanced: 'o4-mini',
        deep: 'o4-mini',
      })
      assert.deepEqual(liteConfig.tiers.opencode, {
        fast: 'anthropic/claude-haiku-4-5',
        balanced: 'anthropic/claude-haiku-4-5',
        deep: 'anthropic/claude-haiku-4-5',
      })

      await syncModelsAndDeploy(liteConfig, { runtime, roots, hosts: SUPPORTED_HOSTS })
      const liteAgyArch = await readFile(
        path.join(roots.antigravity, 'plugins', 'crewseb', 'agents', 'architect.md'),
        'utf8',
      )
      const liteClaudeArch = await readFile(
        path.join(roots.claude, 'agents', 'architect.md'),
        'utf8',
      )
      assert.match(liteAgyArch, /^model:\s*flash_lite$/m)
      assert.match(liteClaudeArch, /^model:\s*haiku$/m)

      // 2. Preset 'hard': frontier models across all 4 hosts and all tiers
      const hardConfig = buildPresetConfig('hard')
      assert.equal(hardConfig.preset, 'hard')
      assert.equal(hardConfig.concurrency.mode, 'parallel')
      assert.equal(hardConfig.concurrency.overflowTarget, 'any')
      assert.deepEqual(hardConfig.tiers.antigravity, {
        fast: 'pro',
        balanced: 'pro',
        deep: 'pro',
      })
      assert.deepEqual(hardConfig.tiers.claude, {
        fast: 'opus',
        balanced: 'opus',
        deep: 'opus',
      })
      assert.deepEqual(hardConfig.tiers.codex, {
        fast: 'o3',
        balanced: 'o3',
        deep: 'o3',
      })
      assert.deepEqual(hardConfig.tiers.opencode, {
        fast: 'anthropic/claude-opus-4-5',
        balanced: 'anthropic/claude-opus-4-5',
        deep: 'anthropic/claude-opus-4-5',
      })

      // 3. Preset 'hybrid' & 'custom' alias: local fast/balanced + cloud lite on deep
      const hybridConfig = buildPresetConfig('hybrid')
      const customAliasConfig = buildPresetConfig('custom')
      assert.equal(hybridConfig.preset, 'hybrid')
      assert.equal(customAliasConfig.preset, 'hybrid')
      assert.equal(hybridConfig.concurrency.mode, 'mixed')
      assert.equal(hybridConfig.concurrency.overflowTarget, 'lite')
      assert.deepEqual(hybridConfig.tiers.opencode, {
        fast: 'ollama/qwen2.5-coder:7b',
        balanced: 'ollama/qwen2.5-coder:7b',
        deep: 'anthropic/claude-haiku-4-5',
      })
      assert.deepEqual(hybridConfig.tiers.codex, {
        fast: 'ollama/qwen2.5-coder:7b',
        balanced: 'ollama/qwen2.5-coder:7b',
        deep: 'o4-mini',
      })
      assert.deepEqual(hybridConfig.tiers.claude, {
        fast: 'ollama/qwen2.5-coder:7b',
        balanced: 'ollama/qwen2.5-coder:7b',
        deep: 'haiku',
      })
      assert.deepEqual(hybridConfig.tiers.antigravity, {
        fast: 'flash_lite',
        balanced: 'flash_lite',
        deep: 'flash_lite',
      })

      // Custom localModel and liteModel options on hybrid
      const customHybrid = buildPresetConfig('custom', {
        localModel: 'qwen2.5-coder:14b',
        liteModel: 'anthropic/claude-haiku-4-5',
      })
      assert.equal(customHybrid.tiers.opencode?.balanced, 'ollama/qwen2.5-coder:14b')
      assert.equal(customHybrid.tiers.claude?.deep, 'anthropic/claude-haiku-4-5')
    } finally {
      await writeAgents(await buildAgents(DEFAULT_PERSONAS))
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('detects simulated GPU via env vars, assesses VRAM capacity, and serves crewseb gpu --json', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-gpu-'))
    try {
      // Case A: 6144 MB RTX 2060 -> 7B model (4500 MB weights + 1000 MB KV) => maxConcurrentAgents = 1, mode = queue
      const { runtime: rtx2060Runtime } = createIsolatedEnv(tmpDir, {
        CREWSEB_GPU_VRAM_MB: '6144',
        CREWSEB_GPU_NAME: 'NVIDIA GeForce RTX 2060',
        CREWSEB_GPU_VENDOR: 'nvidia',
      })

      const gpu2060 = await detectGpu(rtx2060Runtime)
      assert.equal(gpu2060.detected, true)
      assert.equal(gpu2060.name, 'NVIDIA GeForce RTX 2060')
      assert.equal(gpu2060.vramMb, 6144)
      assert.equal(gpu2060.source, 'env')

      const cap2060 = assessVramCapacity(gpu2060, 'ollama/qwen2.5-coder:7b')
      assert.equal(cap2060.weightsMb, 4500)
      assert.equal(cap2060.kvSlotMb, 1000)
      assert.equal(cap2060.maxConcurrentAgents, 1)
      assert.equal(cap2060.recommendedMode, 'queue')

      // CLI `crewseb gpu --json`
      const gpuCliRes = await executeCrewCli(['gpu', '--json'], rtx2060Runtime)
      assert.equal(gpuCliRes.exitCode, 0)
      const gpuWire = JSON.parse(gpuCliRes.stdout)
      assert.equal(gpuWire.status, 'success')
      assert.equal(gpuWire.payload.gpu.name, 'NVIDIA GeForce RTX 2060')
      assert.equal(gpuWire.payload.assessment.maxConcurrentAgents, 1)
      assert.equal(gpuWire.payload.assessment.recommendedMode, 'queue')

      // Case B: 7000 MB GPU -> 7B model (4500 + 1000 = 5500; remaining 1500 / 1000 = 1 extra) => maxConcurrentAgents = 2, mode = mixed
      const { runtime: gpu7000Runtime } = createIsolatedEnv(tmpDir, {
        CREWSEB_GPU_VRAM_MB: '7000',
        CREWSEB_GPU_NAME: 'Simulated 7GB GPU',
      })
      const gpu7000 = await detectGpu(gpu7000Runtime)
      const cap7000 = assessVramCapacity(gpu7000, 'ollama/qwen2.5-coder:7b')
      assert.equal(cap7000.maxConcurrentAgents, 2)
      assert.equal(cap7000.recommendedMode, 'mixed')

      // Estimate helper across parameter sizes
      assert.deepEqual(estimateModelVramMb('ollama/qwen2.5-coder:3b'), {
        weightsMb: 2200,
        kvSlotMb: 600,
      })
      assert.deepEqual(estimateModelVramMb('ollama/qwen2.5-coder:14b'), {
        weightsMb: 9000,
        kvSlotMb: 1500,
      })
      assert.deepEqual(estimateModelVramMb('ollama/deepseek-r1:32b'), {
        weightsMb: 19500,
        kvSlotMb: 2500,
      })
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('blocks excessive parallel local agents with VRAM_LIMIT_EXCEEDED (exitCode: 2) and allows safe or forced configs', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-vram-guard-'))
    try {
      // Simulate a GPU with 7000 MB VRAM (supports max 2 concurrent 7B local agents)
      const { runtime: runtime2Max } = createIsolatedEnv(tmpDir, {
        CREWSEB_GPU_VRAM_MB: '7000',
        CREWSEB_GPU_NAME: 'NVIDIA RTX 7GB',
      })
      await savePersonas(DEFAULT_PERSONAS, runtime2Max)

      // 1. Attempting preset hybrid with --max-local 3 on 2-agent GPU fails with VRAM_LIMIT_EXCEEDED (exitCode 2)
      const rejectPresetJson = await executeCrewCli(
        ['models', 'preset', 'hybrid', '--max-local', '3', '--json'],
        runtime2Max,
      )
      assert.equal(rejectPresetJson.exitCode, 2)
      const rejectPresetWire = JSON.parse(rejectPresetJson.stdout)
      assert.equal(rejectPresetWire.status, 'error')
      assert.equal(rejectPresetWire.fault.code, 'VRAM_LIMIT_EXCEEDED')
      assert.match(rejectPresetWire.fault.reason, /soporta máximo 2 agente\(s\) local\(es\) simultáneo\(s\), pero solicitaste 3/)

      // Plain text mode also returns exitCode 2 and clear warning on stderr
      const rejectPresetText = await executeCrewCli(
        ['models', 'preset', 'hybrid', '--max-local', '3'],
        runtime2Max,
      )
      assert.equal(rejectPresetText.exitCode, 2)
      assert.match(rejectPresetText.stderr, /Límite de VRAM excedido/)
      assert.match(rejectPresetText.stderr, /--mode queue/)
      assert.match(rejectPresetText.stderr, /--mode mixed --max-local 2/)

      // 2. Preset hybrid with --max-local 2 (within limit) succeeds
      const okPreset = await executeCrewCli(
        ['models', 'preset', 'hybrid', '--max-local', '2', '--json'],
        runtime2Max,
      )
      assert.equal(okPreset.exitCode, 0)
      const okPresetWire = JSON.parse(okPreset.stdout)
      assert.equal(okPresetWire.payload.config.concurrency.mode, 'mixed')
      assert.equal(okPresetWire.payload.config.concurrency.maxLocalParallel, 2)

      // 3. `crewseb models concurrency parallel --max-local 3` on 2-agent GPU is rejected
      const rejectConc = await executeCrewCli(
        ['models', 'concurrency', 'parallel', '--max-local', '3', '--json'],
        runtime2Max,
      )
      assert.equal(rejectConc.exitCode, 2)
      assert.equal(JSON.parse(rejectConc.stdout).fault.code, 'VRAM_LIMIT_EXCEEDED')

      // 4. `crewseb models concurrency queue` and `mixed --max-local 2` succeed
      const okQueue = await executeCrewCli(
        ['models', 'concurrency', 'queue', '--max-local', '1', '--json'],
        runtime2Max,
      )
      assert.equal(okQueue.exitCode, 0)
      assert.equal(JSON.parse(okQueue.stdout).payload.config.concurrency.mode, 'queue')

      const okMixed = await executeCrewCli(
        ['models', 'concurrency', 'mixed', '--max-local', '2', '--overflow', 'any', '--json'],
        runtime2Max,
      )
      assert.equal(okMixed.exitCode, 0)
      assert.equal(JSON.parse(okMixed.stdout).payload.config.concurrency.mode, 'mixed')
      assert.equal(JSON.parse(okMixed.stdout).payload.config.concurrency.maxLocalParallel, 2)
      assert.equal(JSON.parse(okMixed.stdout).payload.config.concurrency.overflowTarget, 'any')

      // 5. On a 6144 MB GPU (max 1 local agent), even `concurrency parallel` (defaulting to >=2 parallel) is blocked unless forced
      const { runtime: runtime1Max } = createIsolatedEnv(tmpDir, {
        CREWSEB_GPU_VRAM_MB: '6144',
        CREWSEB_GPU_NAME: 'NVIDIA GeForce RTX 2060',
      })
      const rejectParallelOn1Max = await executeCrewCli(
        ['models', 'concurrency', 'parallel', '--json'],
        runtime1Max,
      )
      assert.equal(rejectParallelOn1Max.exitCode, 2)
      assert.equal(JSON.parse(rejectParallelOn1Max.stdout).fault.code, 'VRAM_LIMIT_EXCEEDED')

      // Passing --force overrides the VRAM guard
      const forcedParallel = await executeCrewCli(
        ['models', 'concurrency', 'parallel', '--max-local', '3', '--force', '--json'],
        runtime1Max,
      )
      assert.equal(forcedParallel.exitCode, 0)
      assert.equal(JSON.parse(forcedParallel.stdout).payload.config.concurrency.maxLocalParallel, 3)

      // Direct unit check on validateLocalConcurrency
      const gpu2060 = await detectGpu(runtime1Max)
      const directBlock = validateLocalConcurrency({ gpu: gpu2060, requestedParallel: 2 })
      assert.equal(directBlock.allowed, false)
      assert.equal(directBlock.maxSupportedParallel, 1)
    } finally {
      await writeAgents(await buildAgents(DEFAULT_PERSONAS))
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('injects queue and mixed concurrency directives into SKILL.md via renderSkillMarkdown and deployCrewseb', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-skill-concurrency-'))
    try {
      const { runtime, roots } = createIsolatedEnv(tmpDir, {
        CREWSEB_GPU_VRAM_MB: '7000',
        CREWSEB_GPU_NAME: 'NVIDIA RTX 7GB',
      })
      await savePersonas(DEFAULT_PERSONAS, runtime)
      const rawSkill = await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')

      // 1. Parallel mode leaves SKILL.md untouched
      const parallelConfig = buildPresetConfig('default')
      assert.equal(renderSkillMarkdown(rawSkill, parallelConfig), rawSkill)

      // 2. Queue mode injects sequential queue policy
      const { config: queueCfg } = await setConcurrencyConfig(
        { mode: 'queue', maxLocalParallel: 1 },
        runtime,
      )
      const queueMd = renderSkillMarkdown(rawSkill, queueCfg)
      assert.match(queueMd, /Modo Cola Activo \(`queue`, maxLocal=1\)/)
      assert.match(queueMd, /encolando el resto secuencialmente/)

      // 3. Mixed mode with overflow=lite and overflow=any injects overflow directive and deploys to host skill files
      const { config: mixedLiteCfg } = await setConcurrencyConfig(
        { mode: 'mixed', maxLocalParallel: 2, overflowTarget: 'lite' },
        runtime,
      )
      await syncModelsAndDeploy(mixedLiteCfg, { runtime, roots, hosts: SUPPORTED_HOSTS })

      const deployedSkillAgy = await readFile(
        path.join(roots.antigravity, 'plugins', 'crewseb', 'skills', 'crewseb', 'SKILL.md'),
        'utf8',
      )
      assert.match(deployedSkillAgy, /Modo Mixto Activo \(`mixed`, maxLocal=2, overflow=lite\)/)
      assert.match(deployedSkillAgy, /usando agentes ligeros \(modelos lite\)/)

      const { config: mixedAnyCfg } = await setConcurrencyConfig(
        { mode: 'mixed', maxLocalParallel: 1, overflowTarget: 'any' },
        runtime,
      )
      const mixedAnyMd = renderSkillMarkdown(rawSkill, mixedAnyCfg)
      assert.match(mixedAnyMd, /Modo Mixto Activo \(`mixed`, maxLocal=1, overflow=any\)/)
      assert.match(mixedAnyMd, /usando agentes ligeros \(cualquier modelo disponible\)/)
    } finally {
      await writeAgents(await buildAgents(DEFAULT_PERSONAS))
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('enforces hybrid precedence hierarchy: role+host > role+* > tier+host > default', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-models-precedence-'))
    try {
      const { runtime } = createIsolatedEnv(tmpDir)

      await setTierModel('balanced', 'ollama/llama3.3:70b', 'opencode', runtime)
      await setRoleModel('researcher', 'ollama/qwen2.5-coder:7b', '*', runtime)
      const { config } = await setRoleModel(
        'researcher',
        'ollama/qwen2.5-coder:32b',
        'opencode',
        runtime,
      )

      assert.equal(config.preset, 'custom')

      const researcherModels = resolveRoleModels('researcher', ROLE_TIERS.researcher, config)
      assert.equal(researcherModels.opencode, 'ollama/qwen2.5-coder:32b')
      assert.equal(researcherModels.codex, 'ollama/qwen2.5-coder:7b')
      assert.equal(researcherModels.claude, 'ollama/qwen2.5-coder:7b')

      const analystModels = resolveRoleModels('analyst', ROLE_TIERS.analyst, config)
      assert.equal(analystModels.opencode, 'ollama/llama3.3:70b')
      assert.equal(analystModels.codex, undefined)
      assert.equal(effectiveDisplayModel('analyst', ROLE_TIERS.analyst, 'codex', config), 'inherit')
      assert.equal(effectiveDisplayModel('analyst', ROLE_TIERS.analyst, 'claude', config), 'sonnet')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles CLI subcommands (list, preset --model, set, set-tier, reset) and validation errors', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-models-cli-'))
    try {
      const { runtime } = createIsolatedEnv(tmpDir)
      await savePersonas(DEFAULT_PERSONAS, runtime)

      // 1. models list --json
      const listRes = await executeCrewCli(['models', 'list', '--json'], runtime)
      assert.equal(listRes.exitCode, 0)
      const listWire = JSON.parse(listRes.stdout)
      assert.equal(listWire.status, 'success')
      assert.equal(listWire.payload.preset, 'default')
      assert.equal(listWire.payload.matrix.length, 10)

      // 2. models preset ollama --model qwen2.5-coder:32b --json (normalizes ollama/ prefix)
      const presetRes = await executeCrewCli(
        ['models', 'preset', 'ollama', '--model', 'qwen2.5-coder:32b', '--json'],
        runtime,
      )
      assert.equal(presetRes.exitCode, 0)
      const presetWire = JSON.parse(presetRes.stdout)
      assert.equal(presetWire.status, 'success')
      assert.equal(presetWire.payload.config.preset, 'ollama')
      assert.equal(presetWire.payload.config.tiers.opencode.fast, 'ollama/qwen2.5-coder:32b')
      assert.equal(presetWire.payload.config.tiers.opencode.balanced, 'ollama/qwen2.5-coder:32b')
      assert.equal(presetWire.payload.config.tiers.opencode.deep, 'ollama/qwen2.5-coder:32b')

      // 3. models set architect pro --host antigravity --json
      const setRes = await executeCrewCli(
        ['models', 'set', 'architect', 'pro', '--host', 'antigravity', '--json'],
        runtime,
      )
      assert.equal(setRes.exitCode, 0)
      const setWire = JSON.parse(setRes.stdout)
      assert.equal(setWire.status, 'success')
      assert.equal(setWire.payload.config.preset, 'custom')
      assert.equal(setWire.payload.config.overrides.architect.antigravity, 'pro')

      // 4. models set-tier deep ollama/deepseek-r1:70b --host opencode --json
      const setTierRes = await executeCrewCli(
        ['models', 'set-tier', 'deep', 'ollama/deepseek-r1:70b', '--host', 'opencode', '--json'],
        runtime,
      )
      assert.equal(setTierRes.exitCode, 0)
      const setTierWire = JSON.parse(setTierRes.stdout)
      assert.equal(setTierWire.status, 'success')
      assert.equal(setTierWire.payload.config.tiers.opencode.deep, 'ollama/deepseek-r1:70b')

      // 5. models reset --json returns to default preset
      const resetRes = await executeCrewCli(['models', 'reset', '--json'], runtime)
      assert.equal(resetRes.exitCode, 0)
      const resetWire = JSON.parse(resetRes.stdout)
      assert.equal(resetWire.status, 'success')
      assert.equal(resetWire.payload.config.preset, 'default')
      const reloaded = await loadModelsConfig(runtime)
      assert.equal(reloaded.preset, 'default')
      assert.deepEqual(reloaded.tiers, {})
      assert.deepEqual(reloaded.overrides, {})

      // 6. Edge-case validation errors (exitCode: 2)
      const badRole = await executeCrewCli(
        ['models', 'set', 'nonexistent-role', 'ollama/qwen2.5-coder:7b', '--json'],
        runtime,
      )
      assert.equal(badRole.exitCode, 2)
      assert.equal(JSON.parse(badRole.stdout).fault.code, 'INVALID_ARGS')

      const badTier = await executeCrewCli(
        ['models', 'set-tier', 'ultra', 'ollama/qwen2.5-coder:7b', '--json'],
        runtime,
      )
      assert.equal(badTier.exitCode, 2)
      assert.equal(JSON.parse(badTier.stdout).fault.code, 'INVALID_TIER')

      const badPreset = await executeCrewCli(
        ['models', 'preset', 'unknown-preset', '--json'],
        runtime,
      )
      assert.equal(badPreset.exitCode, 2)
      assert.equal(JSON.parse(badPreset.stdout).fault.code, 'INVALID_PRESET')

      const badHost = await executeCrewCli(
        ['models', 'set', 'developer', 'pro', '--host', 'invalid-host', '--json'],
        runtime,
      )
      assert.equal(badHost.exitCode, 2)
      assert.equal(JSON.parse(badHost.stdout).fault.code, 'INVALID_HOST')

      const badConcurrency = await executeCrewCli(
        ['models', 'concurrency', 'invalid-mode', '--json'],
        runtime,
      )
      assert.equal(badConcurrency.exitCode, 2)
      assert.equal(JSON.parse(badConcurrency.stdout).fault.code, 'INVALID_CONCURRENCY')

      const badMaxLocal = await executeCrewCli(
        ['models', 'concurrency', 'queue', '--max-local', '0', '--json'],
        runtime,
      )
      assert.equal(badMaxLocal.exitCode, 2)
      assert.equal(JSON.parse(badMaxLocal.stdout).fault.code, 'INVALID_CONCURRENCY')
    } finally {
      await writeAgents(await buildAgents(DEFAULT_PERSONAS))
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})

