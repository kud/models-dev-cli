<div align="center">

# models-dev CLI

Explore the [models.dev](https://models.dev) LLM catalogue from your terminal — fuzzy search, a rich TUI, and copy-to-clipboard model IDs.

[![npm](https://img.shields.io/npm/v/%40kud%2Fmodels-dev-cli.svg?label=%40kud%2Fmodels-dev-cli)](https://www.npmjs.com/package/@kud/models-dev-cli)
![node](https://img.shields.io/badge/node-%3E%3D18-3C873A)
![license](https://img.shields.io/badge/license-MIT-blue)

<img src="assets/preview-tui-details.png" alt="Interactive TUI – details view" width="900" />

</div>

## Install

```bash
# one-shot
npx -p @kud/models-dev-cli models-dev

# or install globally
npm i -g @kud/models-dev-cli
models-dev   # alias: mdl
```

The CLI fetches the live catalogue and opens a split-pane TUI by default. Prefer a non-interactive table? Pass `--ui table` or any flag.

## Development

```bash
git clone https://github.com/kud/models-dev-cli
cd models-dev-cli
npm install
npm link           # exposes `models-dev` and `mdl`
models-dev         # run locally
```

---

📚 **Full documentation → https://kud.io/projects/models-dev-cli/docs**
