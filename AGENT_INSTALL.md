# Agent Installation Protocol (`crewseb`)

If a user asked you (an AI coding agent) to install `crewseb`:

## Option A: Install via npm (Recommended)
```sh
npm install -g crewseb
crewseb setup
```

## Option B: Install from Source (Local Development)

### 1. Ensure `hubseb` is built first
If `../hubseb` exists locally, ensure it is built:
```sh
cd ../hubseb && npm install && npm run build && cd ../crewseb
```

### 2. Install dependencies, compile agents, and run tests
```sh
npm install
npm run build
npm test
```

### 3. Link CLI and run `crewseb setup`
```sh
chmod +x dist/bin/crewseb.js
ln -sf "$(pwd)/dist/bin/crewseb.js" ~/.local/bin/crewseb
crewseb setup
```

### 4. Verify Installation and Connection with `hubseb`
```sh
crewseb check
crewseb roster
crewseb gpu
crewseb models
hubseb ls
hubseb doctor
```

## 5. (Optional) Configure Model Profiles, Local Subagents & GPU Concurrency
```sh
# 1. Standard presets: default, lite (token saving), hard (frontier deep models), cloud-tiered
crewseb models preset default
crewseb models preset lite
crewseb models preset hard
crewseb models preset cloud-tiered

# 2. Hybrid preset (local Ollama models for fast/balanced + cloud lite models for deep/overflow)
crewseb models preset hybrid
crewseb models preset hybrid --local-model ollama/qwen2.5-coder:14b --lite-model haiku

# 3. 100% Local Ollama preset across tiers (auto-configures safe GPU queue concurrency)
crewseb models preset ollama

# 4. Inspect GPU VRAM capacity and configure local concurrency mode (parallel | queue | mixed)
crewseb gpu
crewseb models concurrency queue --max-local 1
crewseb models concurrency mixed --max-local 1 --overflow lite
crewseb models concurrency mixed --max-local 1 --overflow any

# 5. Custom per-role or per-tier overrides
crewseb models set developer ollama/qwen2.5-coder:32b --host opencode
crewseb models set architect pro --host antigravity
crewseb models set-tier fast flash_lite --host antigravity
```
