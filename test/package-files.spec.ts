import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { SUPPORTED_HOSTS, SystemRuntime } from 'hubseb'
import { buildPackagedAgents, SUBAGENTS_DIR, TARGETS_DIR, writeAgents } from '../src/build.ts'
import { setRoleModel } from '../src/models.ts'
import { DEFAULT_PERSONAS, savePersonas } from '../src/personas.ts'
import { deployCrewseb, rerollAndDeploy, syncModelsAndDeploy } from '../src/setup.ts'

async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    out.set(path.relative(dir, file), createHash('sha256').update(await readFile(file)).digest('hex'))
  }
  return out
}

async function packageSnapshot() {
  return { subagents: await snapshot(SUBAGENTS_DIR), targets: await snapshot(TARGETS_DIR) }
}

describe('packaged subagents/ and targets/', () => {
  it('are not rewritten by deploy, models set or reroll', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-package-'))
    try {
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
      await savePersonas({ ...DEFAULT_PERSONAS, developer: 'Zed' }, runtime)
      const before = await packageSnapshot()

      await deployCrewseb({ runtime, roots, hosts: SUPPORTED_HOSTS })
      const { config } = await setRoleModel('developer', 'haiku', 'claude', runtime)
      await syncModelsAndDeploy(config, { runtime, roots, hosts: SUPPORTED_HOSTS })
      await rerollAndDeploy('analyst', { runtime, roots, hosts: SUPPORTED_HOSTS })

      const deployed = await readFile(path.join(roots.claude, 'agents', 'developer.md'), 'utf8')
      assert.match(deployed, /^model:\s*haiku$/m, 'the user config must still reach the host')
      assert.deepEqual(await packageSnapshot(), before)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('match the deterministic build (run `npm run build:agents` if this fails)', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-packaged-'))
    try {
      await writeAgents(await buildPackagedAgents(), path.join(tmpDir, 'subagents'), path.join(tmpDir, 'targets'))
      assert.deepEqual(await snapshot(path.join(tmpDir, 'subagents')), await snapshot(SUBAGENTS_DIR))
      assert.deepEqual(await snapshot(path.join(tmpDir, 'targets')), await snapshot(TARGETS_DIR))
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
