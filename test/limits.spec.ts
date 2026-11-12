import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { SUPPORTED_HOSTS, SystemRuntime } from 'hubseb'
import { executeCrewCli } from '../src/bin/crewseb.ts'
import { buildAgents } from '../src/build.ts'
import {
  DEFAULT_ROLE_LIMITS,
  loadLimitsConfig,
  resetLimitsConfig,
  resolveRoleMaxSteps,
  setRoleLimit,
} from '../src/limits.ts'

describe('crewseb turn limits and CLI engine', () => {
  it('loads default limits and allows setting role and global limits', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-limits-'))
    try {
      const runtime = new SystemRuntime({
        homeDir: tmpDir,
        env: {
          ...process.env,
          CREWSEB_LIMITS_FILE: path.join(tmpDir, 'limits.json'),
        },
      })

      const initial = await loadLimitsConfig(runtime)
      assert.equal(initial.defaultMaxSteps, 50)
      assert.equal(resolveRoleMaxSteps('developer', initial), 80)
      assert.equal(resolveRoleMaxSteps('analyst', initial), 30)

      // Set single role limit
      const updated = await setRoleLimit('developer', 45, runtime)
      assert.equal(resolveRoleMaxSteps('developer', updated), 45)
      assert.equal(resolveRoleMaxSteps('analyst', updated), 30)

      // Set all roles limit
      const allUpdated = await setRoleLimit('all', 25, runtime)
      assert.equal(allUpdated.defaultMaxSteps, 25)
      assert.equal(resolveRoleMaxSteps('developer', allUpdated), 25)
      assert.equal(resolveRoleMaxSteps('researcher', allUpdated), 25)

      // Reset to defaults
      const reset = await resetLimitsConfig(runtime)
      assert.equal(reset.defaultMaxSteps, 50)
      assert.equal(resolveRoleMaxSteps('developer', reset), DEFAULT_ROLE_LIMITS.developer)
      assert.equal(resolveRoleMaxSteps('analyst', reset), DEFAULT_ROLE_LIMITS.analyst)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles CLI commands (limits list, set, reset, turns alias) and JSON envelopes', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-limits-cli-'))
    try {
      const runtime = new SystemRuntime({
        homeDir: tmpDir,
        env: {
          ...process.env,
          HUBSEB_HOME: path.join(tmpDir, '.hubseb'),
          CREWSEB_LIMITS_FILE: path.join(tmpDir, 'limits.json'),
          CREWSEB_MODELS_FILE: path.join(tmpDir, 'models.json'),
          CREWSEB_PERSONAS_FILE: path.join(tmpDir, 'personas.json'),
        },
      })

      // 1. List limits
      const listRes = await executeCrewCli(['limits', 'list'], runtime)
      assert.equal(listRes.exitCode, 0)
      assert.match(listRes.stdout, /Límites de turnos/)
      assert.match(listRes.stdout, /developer/)

      // 2. JSON list
      const jsonListRes = await executeCrewCli(['limits', 'list', '--json'], runtime)
      assert.equal(jsonListRes.exitCode, 0)
      const listWire = JSON.parse(jsonListRes.stdout)
      assert.equal(listWire.status, 'success')
      assert.ok(Array.isArray(listWire.payload.matrix))

      // 3. Set limit via turns alias
      const setRes = await executeCrewCli(['turns', 'set', 'developer', '40'], runtime)
      assert.equal(setRes.exitCode, 0)
      assert.match(setRes.stdout, /Configurado límite para "developer" a 40 pasos/)

      // 4. Verify in buildAgents
      const config = await loadLimitsConfig(runtime)
      const built = await buildAgents(undefined, undefined, undefined, undefined, config)
      const devAgent = built.find((b) => b.name === 'developer')
      assert.ok(devAgent)
      assert.match(devAgent.content, /maxSteps: 40/)

      // 5. Reset via CLI
      const resetRes = await executeCrewCli(['limits', 'reset'], runtime)
      assert.equal(resetRes.exitCode, 0)
      assert.match(resetRes.stdout, /Restablecidos límites de turnos/)

      // 6. Invalid args validation
      const invalidRes = await executeCrewCli(['limits', 'set', 'developer', 'not-a-number'], runtime)
      assert.equal(invalidRes.exitCode, 2)
      assert.match(invalidRes.stderr, /Must be a positive integer/)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
