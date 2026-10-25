# Agent Installation Protocol (`crewseb`)

If a user asked you (an AI coding agent) to install `crewseb` from this repository:

## 1. Ensure `hubseb` is built first
If `../hubseb` exists locally, ensure it is built:
```sh
cd ../hubseb && npm install && npm run build && cd ../crewseb
```

## 2. Install dependencies, compile agents, and run tests
```sh
npm install
npm run build
npm test
```

## 3. Link CLI and run `crewseb setup`
```sh
chmod +x dist/bin/crewseb.js
ln -sf "$(pwd)/dist/bin/crewseb.js" ~/.local/bin/crewseb
crewseb setup
```

## 4. Verify Installation and Connection with `hubseb`
```sh
crewseb check
crewseb roster
crewseb models
hubseb ls
hubseb doctor
```

## 5. (Optional) Configure Local (Ollama) or Custom Models per Role/Tier
```sh
# Local Ollama preset across tiers (fast=qwen2.5-coder:7b, balanced=qwen2.5-coder:14b, deep=deepseek-r1:32b)
crewseb models preset ollama

# Or single local model across all tiers
crewseb models preset ollama --model ollama/qwen2.5-coder:32b

# Or per-role / per-host override
crewseb models set developer ollama/qwen2.5-coder:32b --host opencode
crewseb models set architect pro --host antigravity
```
