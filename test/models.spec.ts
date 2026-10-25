import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { SUPPORTED_HOSTS, SystemRuntime } from 'hubseb'
import { executeCrewCli } from '../src/bin/crewseb.ts'
import { buildAgents, writeAgents } from '../src/build.ts'
import {
  applyModelPreset,
  effectiveDisplayModel,
  loadModelsConfig,
  resolveRoleModels,
  ROLE_TIERS,
  setRoleModel,
  setTierModel,
} from '../src/models.ts'
import { DEFAULT_PERSONAS, savePersonas } from '../src/personas.ts'
import { deployCrewseb, syncModelsAndDeploy } from '../src/setup.ts'

function createIsolatedEnv(tmpDir: string) {
  const runtime = new SystemRuntime({
    homeDir: tmpDir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
      HUBSEB_HOME: path.join(tmpDir, '.hubseb'),
      CREWSEB_MODELS_FILE: path.join(tmpDir, 'crewseb-models.json'),
      CREWSEB_PERSONAS_FILE: path.join(tmpDir, 'personas.json'),
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
    } finally {
      await writeAgents(await buildAgents(DEFAULT_PERSONAS))
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
