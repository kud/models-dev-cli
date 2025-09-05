# models-dev (mdl)

CLI to explore the [models.dev](https://models.dev) model catalogue.
Supports both:
- Non-interactive flag driven usage (script friendly)
- Interactive TUI exploration (search / filter / sort + copy model id)

## Install

```bash
npm i -g models-dev-cli
# or (when repo cloned)
npm install && npm link
```

## Usage (Non-Interactive)

```bash
mdl --search claude
mdl --provider openai --sort input-cost
mdl --tool --reasoning
mdl --provider anthropic --compact
mdl --search grok --json
```

Flags:
- `--search <term>`: substring match on name/id
- `--provider <name>`: provider id or display name (case-insensitive)
- `--tool`: only models supporting tool calling
- `--reasoning`: only models with reasoning capability
- `--sort <field>`: one of `input-cost`, `output-cost`, `provider` (interactive mode exposes many more sort keys)
- `--json`: raw JSON of filtered list
- `--compact`: `provider:model:name:id` lines

If you pass no flags, interactive mode launches automatically. Use `--ui blessed` or `--ui table` (or env `MODELS_DEV_UI=blessed|table`) to force a mode; default is auto-detect (tries blessed then falls back).

## Interactive Mode

```bash
mdl
```

Interactive now has two modes:
1. Legacy prompt loop (if blessed not installed)
2. Split-pane TUI (auto when `blessed` is available) with real-time navigation.

Split-pane TUI keys:
- `/` search (fuzzy; blank clears)
- `p` provider filter selector
- `t` cycle tool filter (Any → Yes → No)
- `r` cycle reasoning filter (Any → Yes → No)
- `s` cycle sort (Default → Provider → Input $ → Output $ → Context)
- `c` copy selected model id
- `h` toggle help/status bar
- `q` quit
- Arrow keys / j k: navigate list; PageUp/PageDown: scroll

Legacy single-letter prompt loop (fallback) controls:
- `s` set search (fuzzy)
- `p` provider filter
- `t` tool filter (Any/Y/N)
- `r` reasoning filter (Any/Y/N)
- `o` sort selection
- `c` copy a model id to clipboard
- `q` quit

Table auto refreshes after each action. Top 30 rows displayed for speed.

## Output Columns
Columns shown in non-interactive & interactive table:
- Provider
- Model (human label)
- Provider ID
- Model ID (full API model id)
- Tool (Y/N)
- Reason (reasoning capability Y/N)
- In Mod (input modalities list)
- Out Mod (output modalities list)
- In $ (input cost / 1M tokens when available)
- Out $ (output cost / 1M tokens when available)
- Cache R (cache read cost / 1M tokens when available)
- Cache W (cache write cost / 1M tokens when available)
- Ctx (context limit tokens)
- Out Lim (max output tokens)
- Temp (temperature adjustable Y/N)
- Weights (OPEN/CLOSED)
- Knowledge (model training/knowledge cutoff if provided)
- Release (release date)
- Updated (last updated date)

Dates are displayed verbatim as provided by the API.
Missing numeric/cost fields show '-'.
## Notes
- Requires Node.js 18+
- Network call: single GET to `https://models.dev/api.json`
- Interactive deps (`inquirer`, `fuse.js`, `clipboardy`) are lazy-loaded

## Roadmap Ideas
- Cache + `--refresh` flag
- Additional filters (context length min, modality)
- Export to CSV / Markdown
- Batch cost comparator (`--compare modelA,modelB,...`)

## License
MIT
