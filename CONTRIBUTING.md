# Contributing to Hightable

Thanks for your interest in Hightable. This document covers how to set up a development environment, the basic workflow, and what to keep in mind when proposing changes.

## Development setup

Prerequisites:

- Node.js 20+
- A native build toolchain (for `better-sqlite3` and `node-pty`):
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `build-essential`, `python3`
  - Windows: Visual Studio Build Tools (Desktop development with C++)
- `claude` and `codex` CLIs on `PATH` (only needed to actually exercise the terminals; the unit tests don't require them).

Clone, install, and run the dev shell:

```bash
git clone https://github.com/heliosasdesigner/Hightable.git
cd Hightable
npm install
npm run dev
```

`npm run dev` does three things in order: compiles the Electron main/preload bundle, rebuilds native modules against Electron's Node ABI, and starts both the Vite dev server and the Electron shell.

## Useful scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Full dev loop: build main, rebuild native, start renderer + Electron. |
| `npm run typecheck` | `tsc --noEmit` across the project. |
| `npm test` | Vitest unit tests (rebuilds native modules against system Node first). |
| `npm run build` | Clean + typecheck + main bundle + renderer bundle. |
| `npm run package` | Build and produce a desktop binary for the current OS. |

## Project layout

```text
src/main/      Electron main process (PTY, SQLite, orchestration, IPC)
src/preload/   contextBridge surface exposed to the renderer
src/renderer/  React + xterm.js UI
src/shared/    Shared IPC types and transcript scrubbing
hightable-Docs/ Design docs, MVP plan, wireframes, verification
```

See [`hightable-Docs/architecture.md`](hightable-Docs/architecture.md) for the process model and module responsibilities before making structural changes.

## Submitting changes

1. Open an issue describing the bug or proposed feature before starting non-trivial work. This avoids duplicate effort and clarifies scope.
2. Branch from `main`. Keep commits focused; squash if a PR ends up with noisy history.
3. Run `npm run typecheck` and `npm test` locally before opening a PR.
4. PR description should state the problem, the change, and how it was verified (manual steps if the test suite doesn't cover it).

## Code style

- TypeScript strict mode is on; don't disable it.
- Prefer narrow, well-named functions over large catch-alls. Match existing patterns in the surrounding file.
- Keep the IPC surface in `src/preload/preload.ts` minimal — every new exposed API widens the renderer's blast radius.
- Maintain Electron security defaults: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP in production. Don't loosen these to "make something work" — discuss in an issue first.

## Security

If you find a security issue, please do **not** open a public issue. Open a private security advisory on GitHub or contact the maintainers directly.

## License

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
