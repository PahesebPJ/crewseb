import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { SUPPORTED_HOSTS, SystemRuntime, TopologyStore } from 'hubseb'
import {
  auditCrewsebDirectives,
  deployCrewseb,
  purgeCrewseb,
} from '../src/setup.ts'

describe('crewseb deployment, SHA-256 audit, topology registration & lockfile purge', () => {
  it('deploys into all 4 host drivers, attaches to hubseb topology, verifies SHA-256 hashes, and purges cleanly', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-deploy-'))
    try {
      const runtime = new SystemRuntime({
        homeDir: tmpDir,
        env: {
          ...process.env,
          HUBSEB_HOME: path.join(tmpDir, '.hubseb'),
          CREWSEB_PERSONAS_FILE: path.join(tmpDir, 'personas.json'),
        },
      })

      const roots = {
        antigravity: path.join(tmpDir, '.gemini', 'config'),
        claude: path.join(tmpDir, '.claude'),
        codex: path.join(tmpDir, '.codex'),
        opencode: path.join(tmpDir, '.config', 'opencode'),
      }

      const outcome = await deployCrewseb({
        runtime,
        roots,
        hosts: SUPPORTED_HOSTS,
      })

      assert.ok(existsSync(outcome.topologyFile))
      assert.equal(outcome.receipts.length, 4)

      // Verify TopologyStore discovers crewseb as provider of crew.personas
      const store = new TopologyStore(runtime)
      const provider = await store.findProvider('crew.personas')
      assert.ok(provider)
      assert.equal(provider.id, 'crewseb')

      // Verify SHA-256 directive integrity across all 4 hosts
      const audits = await auditCrewsebDirectives({
        runtime,
        roots,
        hosts: SUPPORTED_HOSTS,
      })
      assert.equal(audits.length, 4)
      for (const rep of audits) {
        assert.equal(rep.status, 'verified', `Expected verified SHA-256 status on ${rep.hostId}`)
      }

      // Check files exist in all 4 hosts
      assert.ok(existsSync(path.join(roots.antigravity, 'plugins', 'crewseb', 'plugin.json')))
      assert.ok(existsSync(path.join(roots.antigravity, 'plugins', 'crewseb', 'agents', 'developer.md')))
      assert.ok(existsSync(path.join(roots.codex, 'agents', 'developer.toml')))
      assert.ok(existsSync(path.join(roots.opencode, 'agents', 'developer.md')))
      assert.ok(existsSync(path.join(roots.claude, 'agents', 'developer.md')))

      // Purge via lockfiles
      const purgeRes = await purgeCrewseb({
        runtime,
        roots,
        hosts: SUPPORTED_HOSTS,
      })
      assert.equal(purgeRes.detachedFromTopology, true)
      assert.equal(await store.getNode('crewseb'), null)
      assert.equal(existsSync(path.join(roots.antigravity, 'plugins', 'crewseb')), false)
      assert.equal(existsSync(path.join(roots.codex, 'agents', 'developer.toml')), false)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
