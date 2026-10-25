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
hubseb ls
hubseb doctor
```
