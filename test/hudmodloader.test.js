'use strict';

// Tests for the HUDModLoader integration (Data/hudmodloader.ini).
// Everything here runs in plain Node, without Vortex: index.js is loaded with
// stubbed Vortex modules (the same trick as test/install-paths.test.js), and the
// game folder is replaced by a temporary directory.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fsp = nodeFs.promises;

// ---------------------------------------------------------------------------
// Stubs for the Vortex runtime
// ---------------------------------------------------------------------------

// Stand-in for vortex-api's util.getSafe
function getSafe(obj, keyPath, fallback) {
  let current = obj;
  for (const key of keyPath) {
    if (current === undefined || current === null) return fallback;
    current = current[key];
  }
  return current === undefined ? fallback : current;
}

const stubs = {
  'vortex-api': {
    actions: {},
    fs: {
      readFileAsync: (file, encoding) => fsp.readFile(file, encoding),
      writeFileAsync: (file, data, encoding) => fsp.writeFile(file, data, encoding),
      statAsync: (file) => fsp.stat(file),
      ensureDirAsync: (dir) => fsp.mkdir(dir, { recursive: true }),
    },
    util: { getVortexPath: () => 'documents', getSafe },
    selectors: { activeProfileId: () => 'profile1' },
    log: () => {},
    Toggle: () => null,
  },
  'react': {},
  'react-redux': { connect: () => () => null },
  'bluebird': {},
  'winapi-bindings': {},
  'semver': {},
  'vortex-parse-ini': { default: class {}, WinapiFormat: class {} },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return Object.prototype.hasOwnProperty.call(stubs, request)
    ? stubs[request]
    : originalLoad.call(this, request, parent, isMain);
};

const { _hudModLoader: hud } = require(path.join(__dirname, '..', 'index.js'));
Module._load = originalLoad;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GAME_ID = 'fallout76';
const INI_RELATIVE_PATH = path.join('Data', 'hudmodloader.ini');

// What HUDModLoader ships: a plain CRLF list with a line for every mod it
// supports - installed or not - plus one entry of our own ("ManualWidget") that
// the extension knows nothing about.
const SHIPPED_INI = [
  'BuffsMeter',
  'CompatibleShowHealthRedux',
  'EventNotifications',
  'HUDCondition',
  'ManualWidget',
].join('\r\n') + '\r\n';

/** A mod as Vortex keeps it in state.persistent.mods (only the parts we read). */
function makeMod(installationPath, attributes) {
  return { installationPath, attributes: attributes || {} };
}

/** Vortex names a mod's staging folder "<Nexus title> <modId> <version> <timestamp>". */
function makeNexusFolder(title, modId) {
  return `${title} ${modId} 1.0.0 2026-01-01T00-00Z aBcDeFgHi`;
}

function makeGameDir(iniContent) {
  const gameDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'fo76-hudmodloader-'));
  nodeFs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true });
  if (iniContent !== undefined) {
    nodeFs.writeFileSync(path.join(gameDir, INI_RELATIVE_PATH), iniContent, 'utf8');
  }
  return gameDir;
}

function makeState(gameDir, mods) {
  return {
    settings: {
      gameMode: { discovered: { [GAME_ID]: { path: gameDir } } },
      [GAME_ID]: {},
    },
    persistent: {
      profiles: { profile1: { gameId: GAME_ID, modState: {} } },
      mods: { [GAME_ID]: mods || {} },
    },
  };
}

// Minimal fake of the Vortex api object: reading state, dispatching the one
// action the extension uses, and notifications.
function makeApi(state) {
  return {
    store: {
      getState: () => state,
      dispatch: (action) => {
        if (action.type === 'FO76_SET_HUDMODLOADER_PRUNED') {
          state.settings[GAME_ID] = {
            ...state.settings[GAME_ID],
            [hud.SETTING_HUDMODLOADER_PRUNED]: action.payload,
          };
        }
      },
    },
    sendNotification: () => {},
  };
}

function makeProfile(modState) {
  return { gameId: GAME_ID, modState: modState || {} };
}

function readIni(gameDir) {
  return nodeFs.readFileSync(path.join(gameDir, INI_RELATIVE_PATH), 'utf8');
}

// ---------------------------------------------------------------------------
// Pure content helpers
// ---------------------------------------------------------------------------

test('addHudLines: adds a missing widget name, keeps formatting', () => {
  const result = hud.addHudLines(SHIPPED_INI, ['HUDEditor']);
  assert.deepEqual(result.added, ['HUDEditor']);
  assert.equal(result.content, SHIPPED_INI + 'HUDEditor\r\n');
});

test('addHudLines: never duplicates an existing entry', () => {
  const result = hud.addHudLines(SHIPPED_INI, ['EventNotifications']);
  assert.deepEqual(result.added, []);
  // "no change" means the very same string, so the file is not rewritten
  assert.equal(result.content, SHIPPED_INI);
});

test('addHudLines: duplicate detection ignores case, spaces and punctuation', () => {
  const content = 'buffs meter\r\n';
  const result = hud.addHudLines(content, ['BuffsMeter']);
  assert.deepEqual(result.added, []);
  assert.equal(result.content, content);
});

test('addHudLines: adds several new names in one go', () => {
  const result = hud.addHudLines('BuffsMeter\r\n', ['ImprovedBars', 'GlowPercent']);
  assert.deepEqual(result.added, ['ImprovedBars', 'GlowPercent']);
  assert.equal(result.content, 'BuffsMeter\r\nImprovedBars\r\nGlowPercent\r\n');
});

test('addHudLines: LF files stay LF, empty files get plain names', () => {
  assert.equal(hud.addHudLines('BuffsMeter\n', ['HUDEditor']).content,
    'BuffsMeter\nHUDEditor\n');
  assert.equal(hud.addHudLines('', ['BuffsMeter']).content, 'BuffsMeter');
});

test('addHudLines: a potential BOM is preserved', () => {
  const content = '\uFEFFBuffsMeter\r\n';
  assert.equal(hud.addHudLines(content, ['HUDEditor']).content,
    '\uFEFFBuffsMeter\r\nHUDEditor\r\n');
});

test('removeHudLines: removes only the given entry, unknown lines survive', () => {
  const result = hud.removeHudLines(SHIPPED_INI, ['HUDCondition']);
  assert.deepEqual(result.removed, ['HUDCondition']);
  assert.equal(result.content,
    'BuffsMeter\r\nCompatibleShowHealthRedux\r\nEventNotifications\r\nManualWidget\r\n');
});

test('removeHudLines: an absent entry changes nothing', () => {
  const result = hud.removeHudLines(SHIPPED_INI, ['HUDEditor']);
  assert.deepEqual(result.removed, []);
  assert.equal(result.content, SHIPPED_INI);
});

test('removeHudLines: matching ignores case, spaces and punctuation', () => {
  const result = hud.removeHudLines('hud condition\r\nManualWidget\r\n', ['HUDCondition']);
  assert.deepEqual(result.removed, ['hud condition']);
  assert.equal(result.content, 'ManualWidget\r\n');
});

test('reconcileHudLines: adds enabled mods and drops uninstalled ones', () => {
  const result = hud.reconcileHudLines('HUDCondition\r\nManualWidget\r\n',
    ['HUDEditor'], ['HUDCondition']);
  assert.deepEqual(result.added, ['HUDEditor']);
  assert.deepEqual(result.removed, ['HUDCondition']);
  assert.equal(result.content, 'ManualWidget\r\nHUDEditor\r\n');
});

test('reconcileHudLines: a re-installed mod is not pruned', () => {
  const result = hud.reconcileHudLines('ManualWidget\r\n', ['HUDCondition'], ['HUDCondition']);
  assert.deepEqual(result.added, ['HUDCondition']);
  assert.deepEqual(result.removed, []);
  assert.equal(result.content, 'ManualWidget\r\nHUDCondition\r\n');
});

// ---------------------------------------------------------------------------
// Matching mods to hudmodloader.ini names
// ---------------------------------------------------------------------------

test('hudLinesForMod: matches a Nexus installation folder', () => {
  const mod = makeMod(makeNexusFolder('HUD Condition - Armor and weapon', 3114));
  assert.deepEqual(hud.hudLinesForMod(mod), ['HUDCondition']);
});

test('hudLinesForMod: matches a .ba2 recorded at install time', () => {
  // no usable name at all - only the archive the extension saw
  const mod = makeMod('SomeRandomFolder', { ba2archives: ['KillStreakTimer.ba2'] });
  assert.deepEqual(hud.hudLinesForMod(mod), ['KillStreakTimer']);
});

test('hudLinesForMod: matches the name the user gave the mod', () => {
  const mod = makeMod('whatever', { customFileName: 'Vendor Log' });
  assert.deepEqual(hud.hudLinesForMod(mod), ['VendorLog']);
});

test('hudLinesForMod: one mod can provide several widgets', () => {
  const mod = makeMod(makeNexusFolder('Improved Bars and HUD v1.18', 3106),
    { ba2archives: ['ImprovedBars.ba2', 'GlowPercent.ba2', 'HudBarPercentWidgets.ba2'] });
  assert.deepEqual(hud.hudLinesForMod(mod), ['ImprovedBars', 'GlowPercent', 'HudBarPercentWidgets']);
});

test('hudLinesForMod: unrelated mods match nothing', () => {
  assert.deepEqual(hud.hudLinesForMod(makeMod(makeNexusFolder('Map Search Unofficial Update', 4109))), []);
  assert.deepEqual(hud.hudLinesForMod(makeMod(makeNexusFolder('BetterInventory-UO', 3815))), []);
  assert.deepEqual(hud.hudLinesForMod(makeMod(undefined, undefined)), []);
});

test('hudLinesForMod: HUDModLoader itself is not a widget', () => {
  const mod = makeMod(makeNexusFolder('HUDModLoader - HUDTools', 3144),
    { ba2archives: ['HUDModLoader.ba2'] });
  assert.deepEqual(hud.hudLinesForMod(mod), []);
});

// ---------------------------------------------------------------------------
// Against a real Data/hudmodloader.ini in a temporary game folder
// ---------------------------------------------------------------------------

test('update: adds the widget name of an installed and enabled mod', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    editor: makeMod(makeNexusFolder('HUD Editor', 3400)),
  });
  const profile = makeProfile({ editor: { enabled: true } });

  await hud.updateHudModLoaderIni(profile, makeApi(state));

  assert.equal(readIni(gameDir), SHIPPED_INI + 'HUDEditor\r\n');
});

test('update: does not duplicate a name that is already listed', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    notifications: makeMod(makeNexusFolder('Event Notifications', 4104)),
  });
  const profile = makeProfile({ notifications: { enabled: true } });

  await hud.updateHudModLoaderIni(profile, makeApi(state));

  assert.equal(readIni(gameDir), SHIPPED_INI);
});

test('update: leaves names alone that belong to mods we never touched', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  // BuffsMeter/CompatibleShowHealthRedux are in the table but nothing was
  // uninstalled, so their (shipped) lines must survive - the mod may well be
  // installed outside Vortex.
  const state = makeState(gameDir, {});
  await hud.updateHudModLoaderIni(makeProfile({}), makeApi(state));

  assert.equal(readIni(gameDir), SHIPPED_INI);
});

test('update: disabled mods are not added', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    editor: makeMod(makeNexusFolder('HUD Editor', 3400)),
  });
  const profile = makeProfile({ editor: { enabled: false }, ghost: { enabled: true } });

  await hud.updateHudModLoaderIni(profile, makeApi(state));

  assert.equal(readIni(gameDir), SHIPPED_INI);
});

test('update: a missing ini is never created', async (t) => {
  const gameDir = makeGameDir(undefined);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    editor: makeMod(makeNexusFolder('HUD Editor', 3400)),
  });

  await hud.updateHudModLoaderIni(makeProfile({ editor: { enabled: true } }), makeApi(state));

  assert.equal(nodeFs.existsSync(path.join(gameDir, INI_RELATIVE_PATH)), false);
});

test('update: ignores profiles of other games', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {});
  await hud.updateHudModLoaderIni({ gameId: 'skyrimse', modState: {} }, makeApi(state));

  assert.equal(readIni(gameDir), SHIPPED_INI);
});

test('uninstall: removes the widget name and keeps every other line', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    condition: makeMod(makeNexusFolder('HUD Condition - Armor and weapon', 3114)),
  });
  const api = makeApi(state);

  // Vortex emits will-remove-mod while the mod record still exists...
  hud.captureHudLinesForRemoval(GAME_ID, 'condition', {}, api);
  assert.deepEqual(hud.getPrunedHudLines(state), ['HUDCondition']);

  // ...and the mod is gone afterwards, so the next refresh drops the name
  delete state.persistent.mods[GAME_ID].condition;
  await hud.updateHudModLoaderIni(makeProfile({}), api);

  assert.equal(readIni(gameDir),
    'BuffsMeter\r\nCompatibleShowHealthRedux\r\nEventNotifications\r\nManualWidget\r\n');
});

test('uninstall: the next deployment (loader ini restored) does not undo it', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    condition: makeMod(makeNexusFolder('HUD Condition - Armor and weapon', 3114)),
  });
  const api = makeApi(state);

  hud.captureHudLinesForRemoval(GAME_ID, 'condition', {}, api);
  delete state.persistent.mods[GAME_ID].condition;
  await hud.updateHudModLoaderIni(makeProfile({}), api);

  // a deployment copies HUDModLoader's own hudmodloader.ini back into place
  nodeFs.writeFileSync(path.join(gameDir, INI_RELATIVE_PATH), SHIPPED_INI, 'utf8');
  await hud.updateHudModLoaderIni(makeProfile({}), api);

  assert.equal(readIni(gameDir).includes('HUDCondition'), false);
});

test('uninstall: reinstalling the mod adds the name back', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    condition: makeMod(makeNexusFolder('HUD Condition - Armor and weapon', 3114)),
  });
  const api = makeApi(state);

  hud.captureHudLinesForRemoval(GAME_ID, 'condition', {}, api);
  delete state.persistent.mods[GAME_ID].condition;
  await hud.updateHudModLoaderIni(makeProfile({}), api);

  state.persistent.mods[GAME_ID].condition =
    makeMod(makeNexusFolder('HUD Condition - Armor and weapon', 3114));
  await hud.updateHudModLoaderIni(makeProfile({ condition: { enabled: true } }), api);

  assert.equal(readIni(gameDir).includes('HUDCondition\r\n'), true);
});

test('uninstall: a name still needed by another mod is kept', async (t) => {
  const gameDir = makeGameDir('ImprovedBars\r\n');
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    oldVersion: makeMod(makeNexusFolder('Improved Bars and HUD', 3106),
      { ba2archives: ['ImprovedBars.ba2'] }),
    newVersion: makeMod('ImprovedHUD', { ba2archives: ['ImprovedBars.ba2'] }),
  });
  const api = makeApi(state);
  const profile = makeProfile({
    oldVersion: { enabled: false },
    newVersion: { enabled: true },
  });

  hud.captureHudLinesForRemoval(GAME_ID, 'oldVersion', {}, api);
  delete state.persistent.mods[GAME_ID].oldVersion;
  await hud.updateHudModLoaderIni(profile, api);

  assert.equal(readIni(gameDir).includes('ImprovedBars'), true);
});

test('uninstall: a replaced (reinstalled) mod keeps its widget name', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    condition: makeMod(makeNexusFolder('HUD Condition - Armor and weapon', 3114)),
  });
  const api = makeApi(state);

  hud.captureHudLinesForRemoval(GAME_ID, 'condition', { willBeReplaced: true }, api);
  assert.deepEqual(hud.getPrunedHudLines(state), []);

  delete state.persistent.mods[GAME_ID].condition;
  await hud.updateHudModLoaderIni(makeProfile({}), api);

  assert.equal(readIni(gameDir), SHIPPED_INI);
});

test('uninstall: unknown mods leave no trace', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {
    search: makeMod(makeNexusFolder('Map Search Unofficial Update', 4109)),
  });
  const api = makeApi(state);

  hud.captureHudLinesForRemoval(GAME_ID, 'search', {}, api);
  assert.deepEqual(hud.getPrunedHudLines(state), []);

  delete state.persistent.mods[GAME_ID].search;
  await hud.updateHudModLoaderIni(makeProfile({}), api);

  assert.equal(readIni(gameDir), SHIPPED_INI);
});

test('uninstall: mods of another game are ignored', async (t) => {
  const gameDir = makeGameDir(SHIPPED_INI);
  t.after(() => fsp.rm(gameDir, { recursive: true, force: true }));

  const state = makeState(gameDir, {});
  const api = makeApi(state);

  hud.captureHudLinesForRemoval('skyrimse', 'someMod', {}, api);
  assert.deepEqual(hud.getPrunedHudLines(state), []);
  await hud.updateHudModLoaderIni(makeProfile({}), api);

  assert.equal(readIni(gameDir), SHIPPED_INI);
});
