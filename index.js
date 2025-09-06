#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('./package.json');
import fetch from 'node-fetch';
import Table from 'cli-table3';
import chalk from 'chalk';

// Lazy-loaded deps for interactive mode
let inquirer;
let Fuse;
let clipboardy;

const API_URL = 'https://models.dev/api.json';

const fetchCatalogue = async () => {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`Failed to fetch catalogue: ${res.status}`);
  const raw = await res.json();
  const models = [];
  for (const [providerKey, provider] of Object.entries(raw)) {
    if (!provider?.models) continue;
    for (const [, m] of Object.entries(provider.models)) {
      models.push({
        providerId: providerKey,
        provider: provider.name ?? providerKey,
        id: m.id,
        name: m.name,
        tool: !!m.tool_call,
        reasoning: !!m.reasoning,
        attachment: !!m.attachment,
        temperature: !!m.temperature,
        openWeights: !!m.open_weights,
        modalitiesInput: m.modalities?.input ?? [],
        modalitiesOutput: m.modalities?.output ?? [],
        inputCost: m.cost?.input ?? null,
        outputCost: m.cost?.output ?? null,
        cacheReadCost: m.cost?.cache_read ?? null,
        cacheWriteCost: m.cost?.cache_write ?? null,
        contextLimit: m.limit?.context ?? null,
        outputLimit: m.limit?.output ?? null,
        knowledge: m.knowledge ?? null,
        releaseDate: m.release_date ?? null,
        lastUpdated: m.last_updated ?? null
      });
    }
  }
  return models;
};

const applyFilters = (models, { search, provider, tool, reasoning }) => {
  let list = models;
  if (provider) {
    const p = provider.toLowerCase();
    list = list.filter(m => m.provider.toLowerCase() === p || m.providerId.toLowerCase() === p);
  }
  if (tool) list = list.filter(m => m.tool);
  if (reasoning) list = list.filter(m => m.reasoning);
  if (search) {
    const term = search.toLowerCase();
    list = list.filter(m =>
      m.name.toLowerCase().includes(term) ||
      m.id.toLowerCase().includes(term)
    );
  }
  return list;
};

const sorters = {
  'input-cost': (a, b) => (a.inputCost ?? Infinity) - (b.inputCost ?? Infinity),
  'output-cost': (a, b) => (a.outputCost ?? Infinity) - (b.outputCost ?? Infinity),
  provider: (a, b) => a.provider.localeCompare(b.provider)
};

const applySort = (models, sort) => !sort || !sorters[sort] ? models : [...models].sort(sorters[sort]);

const printTable = (models) => {
  const table = new Table({
    head: [
      'Provider','Model','Provider ID','Model ID','Tool','Reason','In Mod','Out Mod','In $','Out $','Cache R','Cache W','Ctx','Out Lim','Temp','Weights','Knowledge','Release','Updated'
    ],
    wordWrap: true,
    colWidths: [12,18,12,18,5,6,10,10,8,8,8,8,8,8,5,8,10,10,10]
  });
  for (const m of models) {
    table.push([
      m.provider,
      m.name,
      m.providerId,
      m.id,
      m.tool ? chalk.green('Y') : chalk.gray('N'),
      m.reasoning ? chalk.green('Y') : chalk.gray('N'),
      m.modalitiesInput.join(',') || '-',
      m.modalitiesOutput.join(',') || '-',
      m.inputCost != null ? `$${m.inputCost}` : '-',
      m.outputCost != null ? `$${m.outputCost}` : '-',
      m.cacheReadCost != null ? `$${m.cacheReadCost}` : '-',
      m.cacheWriteCost != null ? `$${m.cacheWriteCost}` : '-',
      m.contextLimit ?? '-',
      m.outputLimit ?? '-',
      m.temperature ? chalk.green('Y') : chalk.gray('N'),
      m.openWeights ? chalk.green('OPEN') : chalk.gray('CLOSED'),
      m.knowledge ?? '-',
      m.releaseDate ?? '-',
      m.lastUpdated ?? '-'
    ]);
  }
  console.log(table.toString());
};

const printCompact = (models) => {
  for (const m of models) console.log(`${m.provider}:${m.name}:${m.id}`);
};

const interactiveBlessedMode = async () => {
  let blessed, Fuse, clipboardy;
  try {
    ({ default: blessed } = await import('blessed'));
    ({ default: Fuse } = await import('fuse.js'));
    ({ default: clipboardy } = await import('clipboardy'));
  } catch (e) {
    throw new Error('Missing blessed dependencies. Install with: npm install blessed fuse.js clipboardy');
  }

  let models;
  try {
    models = await fetchCatalogue();
  } catch (e) {
    console.error('Failed to load catalogue:', e.message);
    return;
  }
  const providers = [...new Set(models.map(m => m.provider))].sort();
  const allModalities = [...new Set(models.flatMap(m => [
    ...(m.modalitiesInput || []),
    ...(m.modalitiesOutput || [])
  ]))].sort();

  let searchTerm = '';
  let providerFilter = null; // null => Any
  let toolFilter = null;     // null => Any, true => only tool, false => only non tool
  let reasoningFilter = null;// same pattern
  let weightsFilter = null;  // null => Any, true => OPEN, false => CLOSED
  let tempFilter = null;     // null => Any, true => Y, false => N
  let minContextFilter = null; // number|null
  let maxInputCostFilter = null; // number|null
  let maxOutputCostFilter = null; // number|null
  let modInFilter = [];      // string[]
  let modOutFilter = [];     // string[]
  let sortIndex = 0;
  const sortModes = [
    { name: 'Default', fn: null },
    { name: 'Provider', fn: (a,b)=> a.provider.localeCompare(b.provider) },
    { name: 'Input $', fn: (a,b)=> (a.inputCost??Infinity) - (b.inputCost??Infinity) },
    { name: 'Output $', fn: (a,b)=> (a.outputCost??Infinity) - (b.outputCost??Infinity) },
    { name: 'Context', fn: (a,b)=> (b.contextLimit??0) - (a.contextLimit??0) }
  ];

  let filtered = models;

  // Terminal quirk handling: some terminals (notably iTerm2 with TERM=xterm-256color)
  // make blessed spew a Setulc terminfo evaluation error. We aggressively fall back
  // to a simpler term definition and disable tput/terminfo use. Users can force this
  // with MODELS_DEV_FORCE_SIMPLE=1. To retain original TERM despite detection set
  // MODELS_DEV_KEEP_TERM=1.
  const term = process.env.TERM || '';
  const isITerm = (process.env.TERM_PROGRAM || '').toLowerCase().includes('iterm');
  const problematic = /xterm-256color/i.test(term) || isITerm;
  const forceSimple = problematic || process.env.MODELS_DEV_FORCE_SIMPLE === '1';
  if (forceSimple && !process.env.MODELS_DEV_KEEP_TERM) {
    if (!process.env.MODELS_DEV_ORIG_TERM) process.env.MODELS_DEV_ORIG_TERM = term;
    process.env.TERM = 'xterm'; // simplify so blessed skips problematic Setulc expr
  }

  // Create screen with a safe fallback for terminals that choke on terminfo (Setulc error)
  let screen;
  try {
    screen = blessed.screen({
      smartCSR: true,
      title: 'models.dev catalogue',
      fullUnicode: !forceSimple, // disable full unicode in simple mode (safer)
      forceUnicode: !forceSimple,
      tput: false,
      useBCE: false,
      terminal: forceSimple ? 'xterm' : undefined
    });
  } catch (err) {
    // Fallback: downgrade terminal features to avoid Setulc/terminfo eval crashes
    try {
      process.env.TERM = 'xterm';
      screen = blessed.screen({
        smartCSR: true,
        title: 'models.dev catalogue',
        fullUnicode: false,
        forceUnicode: false,
        terminal: 'xterm',
        tput: false,
        useBCE: false
      });
    } catch (err2) {
      throw err; // rethrow original if fallback also fails
    }
  }

  const list = blessed.list({
    parent: screen,
    label: ' {cyan-fg}Models{/cyan-fg} ',
    width: '35%',
    height: '100%-1',
    top: 0,
    left: 0,
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    border: 'line',
    scrollbar: { ch: ' ', inverse: true },
    style: {
      item: { fg: 'white' },
      selected: { inverse: true, bold: true },
      scrollbar: { bg: 'blue' }
    },
    items: []
  });

  const detail = blessed.box({
    parent: screen,
    label: ' Details ',
    left: '35%+1',
    width: '65%-2',
    height: '100%-3',
    top: 0,
    border: 'line',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ', inverse: true },
    content: 'Loading...'
  });

  const status = blessed.box({
    parent: screen,
    bottom: 0,
    height: 2,
    width: '100%',
    tags: true,
    style: { fg: 'gray' },
    content: ''
  });

  const helpText = 'q quit  / search  p provider  t tool  r reasoning  w weights  y temp  x ctx≥  i in$≤  o out$≤  m modalities  s sort  c copy id  h help';
  let showHelp = true;

  function cycleTool() {
    if (toolFilter === null) toolFilter = true; else if (toolFilter === true) toolFilter = false; else toolFilter = null;
  }
  function cycleReasoning() {
    if (reasoningFilter === null) reasoningFilter = true; else if (reasoningFilter === true) reasoningFilter = false; else reasoningFilter = null;
  }
  function cycleSort() { sortIndex = (sortIndex + 1) % sortModes.length; }
  function cycleWeights() { if (weightsFilter === null) weightsFilter = true; else if (weightsFilter === true) weightsFilter = false; else weightsFilter = null; }
  function cycleTemp() { if (tempFilter === null) tempFilter = true; else if (tempFilter === true) tempFilter = false; else tempFilter = null; }

  function fmtBool(v) { return v ? '{green-fg}Y{/green-fg}' : '{gray-fg}N{/gray-fg}'; }
  function fmtOpen(v) { return v ? '{green-fg}OPEN{/green-fg}' : '{gray-fg}CLOSED{/gray-fg}'; }
  function fmtNum(v) { return v == null ? '-' : v; }

  function applyFilters() {
    let listData = models;
    if (searchTerm) {
      const fuse = new Fuse(listData, { keys: ['name','id'], threshold: 0.4 });
      listData = fuse.search(searchTerm).map(r => r.item);
    }
    if (providerFilter) listData = listData.filter(m => m.provider === providerFilter);
    if (toolFilter !== null) listData = listData.filter(m => toolFilter ? m.tool : !m.tool);
    if (reasoningFilter !== null) listData = listData.filter(m => reasoningFilter ? m.reasoning : !m.reasoning);
    if (weightsFilter !== null) listData = listData.filter(m => weightsFilter ? m.openWeights : !m.openWeights);
    if (tempFilter !== null) listData = listData.filter(m => tempFilter ? m.temperature : !m.temperature);
    if (minContextFilter != null) listData = listData.filter(m => (m.contextLimit ?? -Infinity) >= minContextFilter);
    if (maxInputCostFilter != null) listData = listData.filter(m => m.inputCost != null && m.inputCost <= maxInputCostFilter);
    if (maxOutputCostFilter != null) listData = listData.filter(m => m.outputCost != null && m.outputCost <= maxOutputCostFilter);
    if (modInFilter.length) listData = listData.filter(m => modInFilter.every(x => (m.modalitiesInput || []).includes(x)));
    if (modOutFilter.length) listData = listData.filter(m => modOutFilter.every(x => (m.modalitiesOutput || []).includes(x)));
    const sorter = sortModes[sortIndex].fn;
    if (sorter) listData = [...listData].sort(sorter);
    filtered = listData.slice(0, 500); // safety cap
  }

  function formatListItem(m) {
    return `{cyan-fg}${m.provider}{/cyan-fg} {gray-fg}|{/gray-fg} {white-fg}${m.name}{/white-fg}`;
  }

  function updateList(keepSelection = true) {
    const prevId = keepSelection && filtered[list.selected] ? filtered[list.selected].id : null;
    applyFilters();
    list.setItems(filtered.map(formatListItem));
    if (prevId) {
      const idx = filtered.findIndex(m => m.id === prevId);
      if (idx >= 0) list.select(idx); else list.select(0);
    } else {
      list.select(0);
    }
  }

  function updateDetail() {
    const m = filtered[list.selected];
    if (!m) { detail.setContent('No selection'); return; }

    const sep = '─'.repeat(60);
    const label = (t) => `{white-fg}{bold}${t}:{/bold}{/white-fg}`;
    const money = (v) => v == null ? '-' : `{yellow-fg}$${v}{/yellow-fg}`;
    const numCyan = (v) => v == null ? '-' : `{cyan-fg}${v}{/cyan-fg}`;
    const listBlue = (arr) => (arr && arr.length) ? `{blue-fg}${arr.join(', ')}{/blue-fg}` : '-';
    const knowledge = (v) => v ? `{magenta-fg}${v}{/magenta-fg}` : '-';

    const header = (
      `{bold}{cyan-fg}${m.provider}{/cyan-fg}{/bold} {white-fg}›{/white-fg} ` +
      `{bold}${m.name}{/bold}\n` +
      `{blue-fg}${m.id}{/blue-fg}`
    );

    const capabilities = (
      `${label('Capabilities')}  ` +
      `Tool ${fmtBool(m.tool)}   ` +
      `Reason ${fmtBool(m.reasoning)}   ` +
      `Temp ${fmtBool(m.temperature)}   ` +
      `Weights ${fmtOpen(m.openWeights)}`
    );

    const modalities = (
      `${label('Input')}  ${listBlue(m.modalitiesInput)}\n` +
      `${label('Output')} ${listBlue(m.modalitiesOutput)}`
    );

    const costs = (
      `${label('Costs (per 1M)')}  ` +
      `In ${money(m.inputCost)}   ` +
      `Out ${money(m.outputCost)}   ` +
      `CacheR ${money(m.cacheReadCost)}   ` +
      `CacheW ${money(m.cacheWriteCost)}`
    );

    const limits = (
      `${label('Limits')}  ` +
      `Ctx ${numCyan(m.contextLimit)}   ` +
      `Out ${numCyan(m.outputLimit)}`
    );

    const meta = (
      `${label('Knowledge')} ${knowledge(m.knowledge)}\n` +
      `${label('Release')} {white-fg}${m.releaseDate ?? '-'}{/white-fg}   ` +
      `${label('Updated')} {white-fg}${m.lastUpdated ?? '-'}{/white-fg}`
    );

    detail.setContent([
      header,
      sep,
      capabilities,
      '',
      modalities,
      '',
      costs,
      limits,
      '',
      meta
    ].join('\n'));
  }

  function updateStatus(message) {
    if (showHelp) {
      const line1 = `{white-fg}${helpText}{/white-fg}`;
      const line2 = `Search: {yellow-fg}${searchTerm || '*'}{/yellow-fg}  ` +
        `Prov: {yellow-fg}${providerFilter || '*'}{/yellow-fg}  ` +
        `Tool: {yellow-fg}${toolFilter===null?'*':(toolFilter?'Y':'N')}{/yellow-fg}  ` +
        `Reason: {yellow-fg}${reasoningFilter===null?'*':(reasoningFilter?'Y':'N')}{/yellow-fg}  ` +
        `Wgts: {yellow-fg}${weightsFilter===null?'*':(weightsFilter?'OPEN':'CLOSED')}{/yellow-fg}  ` +
        `Temp: {yellow-fg}${tempFilter===null?'*':(tempFilter?'Y':'N')}{/yellow-fg}  ` +
        `Ctx≥ {yellow-fg}${minContextFilter ?? '*'}{/yellow-fg}  ` +
        `In$≤ {yellow-fg}${maxInputCostFilter ?? '*'}{/yellow-fg}  ` +
        `Out$≤ {yellow-fg}${maxOutputCostFilter ?? '*'}{/yellow-fg}  ` +
        `InMod {yellow-fg}${modInFilter.length?modInFilter.join(','): '*'}{/yellow-fg}  ` +
        `OutMod {yellow-fg}${modOutFilter.length?modOutFilter.join(','): '*'}{/yellow-fg}  ` +
        `Sort: {yellow-fg}${sortModes[sortIndex].name}{/yellow-fg}  ` +
        `Shown: {yellow-fg}${filtered.length}{/yellow-fg}/${models.length}` +
        (message ? `  | ${message}` : '');
      status.setContent(line1 + "\n" + line2);
    } else if (message) {
      status.setContent(message);
    } else {
      status.setContent('');
    }
  }

  function refresh(keepSel = true, msg) {
    updateList(keepSel);
    updateDetail();
    updateStatus(msg);
    screen.render();
  }

  function promptSearch() {
    const prompt = blessed.prompt({
      parent: screen,
      tags: true,
      label: ' {cyan-fg}Search{/cyan-fg} ',
      width: '50%',
      height: 'shrink',
      border: 'line',
      keys: true,
      vi: true
    });
    prompt.input('Search term (blank clears):', searchTerm, (err, value) => {
      if (!err) {
        searchTerm = (value || '').trim();
        refresh(false, 'Search updated');
      }
      prompt.destroy();
      list.focus();
      screen.render();
    });
    prompt.focus();
    screen.render();
  }

  function providerSelect() {
    const choices = ['Any', ...providers];
    const display = choices.map((c, i) => i === 0 ? '{yellow-fg}Any{/yellow-fg}' : `{cyan-fg}${c}{/cyan-fg}`);
    const modal = blessed.list({
      parent: screen,
      tags: true,
      label: ' {cyan-fg}Provider{/cyan-fg} ',
      width: '30%',
      height: '60%',
      top: 'center',
      left: 'center',
      border: 'line',
      keys: true,
      vi: true,
      mouse: true,
      style: {
        item: { fg: 'white' },
        selected: { inverse: true, bold: true }
      },
      items: display
    });
    modal.focus();
    modal.on('select', (_, idx) => {
      providerFilter = idx === 0 ? null : choices[idx];
      modal.destroy();
      refresh(false, 'Provider updated');
    });
    screen.key(['escape'], function escHandler() {
      if (!modal.destroyed) {
        modal.destroy();
        screen.off('key', escHandler);
        list.focus();
        screen.render();
      }
    });
    screen.render();
  }

  function promptNumber(title, current, onSet) {
    const prompt = blessed.prompt({ parent: screen, tags: true, label: ` {cyan-fg}${title}{/cyan-fg} `, width: '40%', height: 'shrink', border: 'line', keys: true, vi: true });
    prompt.input('Blank to clear:', current == null ? '' : String(current), (err, value) => {
      if (!err) {
        const v = (value || '').trim();
        onSet(v ? Number(v) : null);
        refresh(false, `${title} updated`);
      }
      prompt.destroy(); list.focus(); screen.render();
    });
    prompt.focus(); screen.render();
  }

  function modalitiesSelect() {
    const inSet = new Set(modInFilter);
    const outSet = new Set(modOutFilter);
    const modal = blessed.box({
      parent: screen,
      label: ' {cyan-fg}Modalities{/cyan-fg} ',
      top: 'center', left: 'center', width: '60%', height: '70%',
      border: 'line', tags: true
    });

    const renderItems = (set) => allModalities.map(n => `${set.has(n) ? '{green-fg}☑{/green-fg}' : '☐'} ${n}`);

    const listIn = blessed.list({
      parent: modal,
      label: ' {cyan-fg}Input{/cyan-fg} ',
      left: 0, top: 0, width: '50%-1', height: '100%-1',
      tags: true, keys: true, vi: true, mouse: true,
      style: { selected: { inverse: true } },
      items: renderItems(inSet)
    });
    const listOut = blessed.list({
      parent: modal,
      label: ' {cyan-fg}Output{/cyan-fg} ',
      left: '50%+1', top: 0, width: '50%-2', height: '100%-1',
      tags: true, keys: true, vi: true, mouse: true,
      style: { selected: { inverse: true } },
      items: renderItems(outSet)
    });

    function toggle(list, set) {
      const idx = list.selected;
      const name = allModalities[idx];
      if (!name) return;
      if (set.has(name)) set.delete(name); else set.add(name);
      list.setItem(idx, renderItems(set)[idx]);
      screen.render();
    }

    listIn.on('keypress', (ch, key) => {
      if (key.name === 'space') toggle(listIn, inSet);
      if (key.name === 'tab') { listOut.focus(); screen.render(); }
    });
    listOut.on('keypress', (ch, key) => {
      if (key.name === 'space') toggle(listOut, outSet);
      if (key.name === 'tab') { listIn.focus(); screen.render(); }
    });

    const escHandler = function escHandler() {
      if (!modal.destroyed) {
        modInFilter = Array.from(inSet);
        modOutFilter = Array.from(outSet);
        modal.destroy();
        screen.off('key', escHandler);
        refresh(false, 'Modalities updated');
      }
    };
    screen.key(['escape'], escHandler);
    listIn.focus();
    screen.render();
  }

  // Key bindings
  screen.key(['q', 'C-c'], () => process.exit(0));
  screen.key('/', promptSearch);
  screen.key('p', providerSelect);
  screen.key('t', () => { cycleTool(); refresh(true, 'Tool filter'); });
  screen.key('r', () => { cycleReasoning(); refresh(true, 'Reason filter'); });
  screen.key('s', () => { cycleSort(); refresh(true, 'Sort changed'); });
  screen.key('w', () => { cycleWeights(); refresh(true, 'Weights filter'); });
  screen.key('y', () => { cycleTemp(); refresh(true, 'Temp filter'); });
  screen.key('x', () => { promptNumber('Min Context', minContextFilter, v => { minContextFilter = v; }); });
  screen.key('i', () => { promptNumber('Max Input $ (per 1M)', maxInputCostFilter, v => { maxInputCostFilter = v; }); });
  screen.key('o', () => { promptNumber('Max Output $ (per 1M)', maxOutputCostFilter, v => { maxOutputCostFilter = v; }); });
  screen.key('m', () => { modalitiesSelect(); });
  screen.key('c', async () => {
    const m = filtered[list.selected];
    if (!m) return;
    try {
      await clipboardy.write(m.id);
      updateStatus(`Copied ${m.id}`);
      screen.render();
    } catch {
      updateStatus('Copy failed');
    }
  });
  screen.key('h', () => { showHelp = !showHelp; refresh(true); });

  list.on('keypress', () => { updateDetail(); screen.render(); });
  list.on('scroll', () => { updateDetail(); screen.render(); });
  list.on('click', () => { updateDetail(); screen.render(); });

  // Initial render
  try {
    refresh(false, 'Loaded');
    list.focus();
  } catch (e) {
    console.error('Interactive UI init failed, falling back to table view:', e.message);
    printTable(models.slice(0, 30));
  }
};

const interactiveTableMode = async () => {
  try {
    ({ default: inquirer } = await import('inquirer'));
    ({ default: Fuse } = await import('fuse.js'));
    clipboardy = (await import('clipboardy')).default;
  } catch (e) {
    console.error('Missing interactive dependencies. Ensure they are installed.');
    process.exit(1);
  }

  let models = await fetchCatalogue();
  let searchTerm = '';
  let provider = 'Any';
  let tool = 'Any';
  let reasoning = 'Any';
  let sort = 'Default';

  // Additional filters for table mode
  let minContext = null;       // number | null
  let maxInputCost = null;     // number | null
  let maxOutputCost = null;    // number | null
  let weights = 'Any';         // Any | OPEN | CLOSED
  let temperature = 'Any';     // Any | Y | N
  let modIn = [];              // string[]
  let modOut = [];             // string[]

  // Pagination
  let page = 0;
  let pageSize = 30;

  const providers = [...new Set(models.map(m => m.provider))].sort();
  const allModalities = [...new Set(models.flatMap(m => [
    ...(m.modalitiesInput || []),
    ...(m.modalitiesOutput || [])
  ]))].sort();

  const interactiveSortMap = {
    'Input cost asc': ['inputCost', 1],
    'Input cost desc': ['inputCost', -1],
    'Output cost asc': ['outputCost', 1],
    'Output cost desc': ['outputCost', -1],
    'Cache read asc': ['cacheReadCost', 1],
    'Cache read desc': ['cacheReadCost', -1],
    'Context asc': ['contextLimit', 1],
    'Context desc': ['contextLimit', -1],
    'Output limit asc': ['outputLimit', 1],
    'Output limit desc': ['outputLimit', -1],
    'Release date new': ['releaseDate', -1],
    'Release date old': ['releaseDate', 1],
    'Updated new': ['lastUpdated', -1],
    'Updated old': ['lastUpdated', 1],
    'Provider A-Z': ['provider', 1],
    'Provider Z-A': ['provider', -1]
  };

  const currentFiltered = () => {
    let list = models;
    if (searchTerm) {
      const fuse = new Fuse(list, { keys: ['name', 'id'], threshold: 0.4 });
      list = fuse.search(searchTerm).map(r => r.item);
    }
    if (provider !== 'Any') list = list.filter(m => m.provider === provider);
    if (tool !== 'Any') list = list.filter(m => (tool === 'Y' ? m.tool : !m.tool));
    if (reasoning !== 'Any') list = list.filter(m => (reasoning === 'Y' ? m.reasoning : !m.reasoning));
    if (weights !== 'Any') list = list.filter(m => weights === 'OPEN' ? m.openWeights : !m.openWeights);
    if (temperature !== 'Any') list = list.filter(m => temperature === 'Y' ? m.temperature : !m.temperature);
    if (minContext != null) list = list.filter(m => (m.contextLimit ?? -Infinity) >= minContext);
    if (maxInputCost != null) list = list.filter(m => m.inputCost != null && m.inputCost <= maxInputCost);
    if (maxOutputCost != null) list = list.filter(m => m.outputCost != null && m.outputCost <= maxOutputCost);
    if (modIn.length) list = list.filter(m => modIn.every(x => (m.modalitiesInput || []).includes(x)));
    if (modOut.length) list = list.filter(m => modOut.every(x => (m.modalitiesOutput || []).includes(x)));
    if (sort !== 'Default') {
      const [field, dir] = interactiveSortMap[sort] ?? [];
      if (field) {
        list = [...list].sort((a, b) => {
          const av = a[field] ?? Infinity;
          const bv = b[field] ?? Infinity;
          return typeof av === 'string' ? dir * av.localeCompare(bv) : dir * (av - bv);
        });
      }
    }
    return list;
  };

  const loop = async () => {
    const full = currentFiltered();
    const pages = Math.max(1, Math.ceil(full.length / pageSize));
    if (page >= pages) page = pages - 1;
    const start = page * pageSize;
    const end = Math.min(full.length, start + pageSize);
    const pageItems = full.slice(start, end);

    console.clear();
    console.log(chalk.cyan.bold('models.dev catalogue (Interactive Table)'));
    console.log(chalk.gray(`Filters:`),
      chalk.yellow(`search:`), searchTerm || '*',
      chalk.yellow(`prov:`), provider,
      chalk.yellow(`tool:`), tool,
      chalk.yellow(`reason:`), reasoning,
      chalk.yellow(`weights:`), weights,
      chalk.yellow(`temp:`), temperature,
      chalk.yellow(`ctx>=`), minContext ?? '-',
      chalk.yellow(`in$<=`), maxInputCost ?? '-',
      chalk.yellow(`out$<=`), maxOutputCost ?? '-',
      chalk.yellow(`inMod:`), modIn.length ? modIn.join(',') : '-',
      chalk.yellow(`outMod:`), modOut.length ? modOut.join(',') : '-'
    );
    console.log(chalk.gray(`Showing ${start + 1}-${end} of ${full.length}  page ${page + 1}/${pages}  size ${pageSize}`));
    printTable(pageItems);
    console.log(chalk.gray('Actions: (s)earch (p)rovider (t)ool (r)eason s(o)rt (w)eights (temp) (ctx) (in)max$ (out)max$ (m)odalities (ps)ize (n)ext (b)ack (g)o (c)opy (clear) (q)uit'));
    const { action } = await inquirer.prompt([
      { name: 'action', type: 'input', message: 'Command:' }
    ]);

    const cmd = (action || '').toLowerCase().trim();
    switch (cmd) {
      case 's': {
        const { term } = await inquirer.prompt([{ name: 'term', type: 'input', message: 'Search term (blank clears):', default: searchTerm }]);
        searchTerm = term.trim();
        page = 0;
        break;
      }
      case 'p': {
        const { prov } = await inquirer.prompt([{ name: 'prov', type: 'list', message: 'Provider filter', choices: ['Any', ...providers], default: provider }]);
        provider = prov;
        page = 0;
        break;
      }
      case 't': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'list', message: 'Tool calling filter', choices: ['Any', 'Y', 'N'], default: tool }]);
        tool = val;
        page = 0;
        break;
      }
      case 'r': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'list', message: 'Reasoning filter', choices: ['Any', 'Y', 'N'], default: reasoning }]);
        reasoning = val;
        page = 0;
        break;
      }
      case 'o': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'list', message: 'Sort', choices: ['Default','Input cost asc','Input cost desc','Output cost asc','Output cost desc','Cache read asc','Cache read desc','Context asc','Context desc','Output limit asc','Output limit desc','Release date new','Release date old','Updated new','Updated old','Provider A-Z','Provider Z-A'], default: sort }]);
        sort = val;
        break;
      }
      case 'w': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'list', message: 'Weights openness', choices: ['Any', 'OPEN', 'CLOSED'], default: weights }]);
        weights = val;
        page = 0;
        break;
      }
      case 'temp': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'list', message: 'Temperature adjustable', choices: ['Any', 'Y', 'N'], default: temperature }]);
        temperature = val;
        page = 0;
        break;
      }
      case 'ctx':
      case 'x': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'input', message: 'Min context length (blank clears):', default: minContext ?? '' }]);
        const n = String(val).trim();
        minContext = n ? Number(n) : null;
        page = 0;
        break;
      }
      case 'in': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'input', message: 'Max INPUT cost per 1M (blank clears):', default: maxInputCost ?? '' }]);
        const n = String(val).trim();
        maxInputCost = n ? Number(n) : null;
        page = 0;
        break;
      }
      case 'out': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'input', message: 'Max OUTPUT cost per 1M (blank clears):', default: maxOutputCost ?? '' }]);
        const n = String(val).trim();
        maxOutputCost = n ? Number(n) : null;
        page = 0;
        break;
      }
      case 'm': {
        const answers = await inquirer.prompt([
          { name: 'in', type: 'checkbox', message: 'Input modalities (empty = any)', choices: allModalities, default: modIn },
          { name: 'out', type: 'checkbox', message: 'Output modalities (empty = any)', choices: allModalities, default: modOut }
        ]);
        modIn = answers.in;
        modOut = answers.out;
        page = 0;
        break;
      }
      case 'ps': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'input', message: 'Page size:', default: String(pageSize) }]);
        pageSize = Math.max(1, Number(String(val).trim()) || pageSize);
        page = 0;
        break;
      }
      case 'n':
      case 'next': {
        page = Math.min(pages - 1, page + 1);
        break;
      }
      case 'b':
      case 'prev':
      case 'back': {
        page = Math.max(0, page - 1);
        break;
      }
      case 'g':
      case 'go': {
        const { val } = await inquirer.prompt([{ name: 'val', type: 'input', message: `Go to page (1-${pages}):`, default: String(page + 1) }]);
        const n = Math.max(1, Math.min(pages, Number(String(val).trim()) || 1));
        page = n - 1;
        break;
      }
      case 'c': {
        if (!pageItems.length) {
          console.log('Nothing to copy.');
          break;
        }
        const { mid } = await inquirer.prompt([{ name: 'mid', type: 'list', message: 'Select model to copy ID', choices: pageItems.map(m => ({ name: `${m.provider} | ${m.name} | ${m.id}`, value: m.id })) }]);
        await clipboardy.write(mid);
        console.log(chalk.green('Copied to clipboard.'));
        await new Promise(r => setTimeout(r, 700));
        break;
      }
      case 'clear': {
        searchTerm = '';
        provider = 'Any';
        tool = 'Any';
        reasoning = 'Any';
        weights = 'Any';
        temperature = 'Any';
        minContext = null;
        maxInputCost = null;
        maxOutputCost = null;
        modIn = [];
        modOut = [];
        page = 0;
        break;
      }
      case 'q':
        return;
      default:
        break;
    }
    await loop();
  };
  await loop();
};

const program = new Command();
program
  .name('models-dev')
  .version(pkg.version)
  .description('Explore the models.dev catalogue (non-interactive & interactive)')
  .option('--search <term>', 'Search by model name or id')
  .option('--provider <name>', 'Filter by provider (id or name)')
  .option('--tool', 'Only models with tool calling')
  .option('--reasoning', 'Only models with reasoning capability')
  .option('--sort <field>', 'Sort by field: input-cost | output-cost | provider')
  .option('--json', 'Output raw JSON for resulting models')
  .option('--compact', 'Compact output provider:model:name:id (non-JSON)')
  .option('--ui <mode>', 'Interactive UI mode: blessed | table | auto (default)')
  .action(async (opts) => {
    const otherFlagKeys = ['search','provider','tool','reasoning','sort','json','compact'];
    const passedOtherFlags = otherFlagKeys.some(k => opts[k] !== undefined);
    const uiReq = opts.ui || process.env.MODELS_DEV_UI || null;

    // If UI is explicitly requested, honor it regardless of other flags
    if (uiReq === 'table') {
      await interactiveTableMode();
      return;
    }
    if (uiReq === 'blessed') {
      try { await interactiveBlessedMode(); return; }
      catch (e) { console.error('Blessed UI failed, falling back to table mode:', e.message); await interactiveTableMode(); return; }
    }
    if (!passedOtherFlags && (!uiReq || uiReq === 'auto')) {
      // Auto-detect: try blessed then table
      try { await interactiveBlessedMode(); return; }
      catch (e) { console.error('Blessed UI failed, falling back to table mode:', e.message); await interactiveTableMode(); return; }
    }
    try {
      let models = await fetchCatalogue();
      models = applyFilters(models, {
        search: opts.search,
        provider: opts.provider,
        tool: opts.tool,
        reasoning: opts.reasoning
      });
      models = applySort(models, opts.sort);
      if (opts.json) {
        console.log(JSON.stringify(models, null, 2));
        return;
      }
      if (opts.compact) {
        printCompact(models);
        return;
      }
      printTable(models);
    } catch (err) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
