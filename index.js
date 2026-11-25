const { actions, fs, util, selectors, log, Toggle } = require('vortex-api');
const React = require('react');
const { connect } = require('react-redux');
const Promise = require("bluebird");
const winapi = require('winapi-bindings');
const path = require('path');
const semver = require('semver');
const IniParser = require('vortex-parse-ini');
const parser = new IniParser.default(new IniParser.WinapiFormat());

const GAME_ID = 'fallout76';
const STEAM_APP_ID = '1151340';
const XBOX_ID = 'BethesdaSoftworks.Fallout76-PC';
const ARCHIVE_EXT = '.ba2';
// Subfolders of Data/ whose files must keep their subfolder structure
const STANDARD_DATA_DIRS = [
  'interface', 'meshes', 'music', 'scripts', 'sound',
  'strings', 'textures', 'materials', 'programs', 'video', 'vis'
];
const fallout76CustomINI = 'Fallout76Custom.ini';
const iniPath = path.join(util.getVortexPath('documents'), 'My Games', 'Fallout 76');
const SETTING_REMOVE_DISABLED = 'removeDisabledArchives';
// Widget names of uninstalled mods that must stay out of Data/hudmodloader.ini
const SETTING_HUDMODLOADER_PRUNED = 'hudModLoaderPrunedLines';

const tools = [
  {
    id: 'FO76Edit',
    name: 'FO76Edit',
    logo: path.join('assets', 'fo76edit.png'),
    executable: () => 'FO76Edit.exe',
    requiredFiles: []
  }
]

// ============ Settings Reducer ============
// Vortex expects an IReducerSpec ({ reducers, defaults }), not a classic
// (state, action) reducer function - a plain function is silently ignored,
// which made the settings toggle appear dead.
const settingsReducer = {
  reducers: {
    'FO76_SET_REMOVE_DISABLED_ARCHIVES': (state, payload) =>
      util.setSafe(state, [SETTING_REMOVE_DISABLED], payload),
    'FO76_SET_HUDMODLOADER_PRUNED': (state, payload) =>
      util.setSafe(state, [SETTING_HUDMODLOADER_PRUNED], payload),
  },
  defaults: {
    [SETTING_REMOVE_DISABLED]: true,
    [SETTING_HUDMODLOADER_PRUNED]: [],
  },
};

// ============ Settings UI Component ============
function SettingsBase({ removeDisabledArchives, onToggle }) {
  return React.createElement('div', { style: { overflow: 'auto', padding: '15px 0' } },
    React.createElement(Toggle, {
      checked: removeDisabledArchives,
      onToggle: onToggle,
    }, 'Remove disabled mod archives from INI'),
    React.createElement('p', { style: { marginTop: '5px' } },
      'When enabled, .ba2 archives from disabled or uninstalled mods are removed from ',
      React.createElement('code', null, 'sResourceArchive2List'),
      ' in Fallout76Custom.ini. When disabled, only archives from enabled mods are added, ',
      'but existing entries in the INI are preserved.'
    )
  );
}

function mapStateToProps(state) {
  return {
    removeDisabledArchives: util.getSafe(state,
      ['settings', GAME_ID, SETTING_REMOVE_DISABLED], true),
  };
}

function mapDispatchToProps(dispatch) {
  return {
    onToggle: (enabled) => dispatch({
      type: 'FO76_SET_REMOVE_DISABLED_ARCHIVES', payload: enabled
    }),
  };
}

const Settings = connect(mapStateToProps, mapDispatchToProps)(SettingsBase);

async function findGame() {
  return util.GameStoreHelper.findByAppId([STEAM_APP_ID, XBOX_ID])
    .then((game) => {
      return game.gamePath;
      // return (game.gameStoreId === 'xbox') ? path.join(game.gamePath, 'Content') : game.gamePath;
    })
    .catch((err) => {
      // Try finding the game on Bethesda.net if the Steam detection fails.
      const bethNetPath = winapi.RegGetValue('HKEY_LOCAL_MACHINE',
        'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fallout 76',
        'Path');
      if (!bethNetPath) throw new Error('empty registry key');
      return Promise.resolve(instPath.value);
    });
}

function onGameModeActivated(gameId, api) {
  // Exit if we aren't managing Fallout 76
  if (gameId !== GAME_ID) return;
  const ini = path.join(iniPath, fallout76CustomINI)

  const refreshIniFiles = () => {
    const state = api.store.getState();
    const profileId = selectors.activeProfileId(state);
    const profile = state.persistent.profiles[profileId];
    if (profile && profile.gameId === GAME_ID) {
      updateManagedIniFiles(profile, api);
    }
  };

  // Make sure the folder in My Documents exists, create it if not. 
  return fs.ensureDirAsync(iniPath)
    .then(() => {
      // See if our INI exists
      return fs.statAsync(ini)
        .then(() => {
          refreshIniFiles();
          return ini;
        })
        .catch(err => {
          // If the INI doesn't exist, make one.
          if (err.code === 'ENOENT') {
            return createINI(ini, api).then((createdIni) => {
              if (createdIni) refreshIniFiles();
              return createdIni;
            });
          }
          // report any other errors.
          else api.sendNotification({ id: 'fallout76-ini-error', type: 'error', title: 'Error reading Fallout76Custom.ini', message: `${err.code} - ${err.message}` });
        })
    })
    .catch((err) => console.log('Error checking INI folder', err))

}

function createINI(iniLocation, api) {
  // Creates a new Fallout76Custom.ini with the default settings
  const defaultData =
    '[Archive]\n' +
    'sResourceArchive2List=\n' +
    'sResourceDataDirsFinal=STRINGS\\\n' +
    'bInvalidateOlderFiles=1\n';

  return fs.writeFileAsync(iniLocation, defaultData).then(() => iniLocation)
    .catch((err) => {
      api.sendNotification({ id: 'fallout76-ini-create-error', type: 'error', title: 'Could not create Fallout76Custom.ini', message: `${err.code} - ${err.message}` });
      return '';
    });
}

function sanitizeDestination(file) {
  // Normalize leading slashes/backslashes
  let clean = file.replace(/^[\\/]+/, '');

  // Strip leading "Data/" or "Data\\" folders (case-insensitive), repeating if nested (e.g. Data/Data/)
  while (/^data[\\/]/i.test(clean)) {
    clean = clean.replace(/^data[\\/]/i, '');
  }

  // Handle case where a wrapper folder wraps Data/, e.g. "ModFolder/Data/..."
  const wrapperMatch = clean.match(/^([^\\/]+)[\\/]data[\\/](.*)$/i);
  if (wrapperMatch) {
    const topFolder = wrapperMatch[1].toLowerCase();
    if (!STANDARD_DATA_DIRS.includes(topFolder)) {
      clean = wrapperMatch[2];
      while (/^data[\\/]/i.test(clean)) {
        clean = clean.replace(/^data[\\/]/i, '');
      }
    }
  }

  return clean;
}

/**
 * Detects a single top-level wrapper folder (e.g. "SmootherFishing/SmootherFishing.ba2"),
 * where the whole mod lives inside one folder that is neither "Data" nor a standard
 * Data subfolder (interface, meshes, ...). Returns the normalized folder name to strip,
 * or undefined if the archive doesn't match this layout.
 *
 * A top-level folder is only treated as a removable wrapper when its root level
 * looks like a mod root: a content file (.ba2/.esm/.cdx/.ini) directly inside it
 * or a standard Data subfolder under it. Folders that only contain non-standard
 * subfolders are functional runtime directories (e.g. XSCAL/Plugins/... which the
 * XSCAL loader expects at Data\\XSCAL\\Plugins) and must be kept.
 */
function detectWrapperFolder(files) {
  const isDir = (f) => f.endsWith('/') || f.endsWith('\\');
  const MOD_ROOT_EXTENSIONS = ['.ba2', '.esm', '.cdx', '.ini'];

  const topLevel = new Set();
  for (const f of files) {
    if (isDir(f)) continue;
    const normalized = f.replace(/\\/g, '/');
    const sepIdx = normalized.indexOf('/');
    if (sepIdx === -1) continue; // files at the archive root stay at the root
    topLevel.add(normalized.slice(0, sepIdx).toLowerCase());
  }

  if (topLevel.size !== 1) return undefined;

  const wrapper = [...topLevel][0];
  if (wrapper === 'data' || STANDARD_DATA_DIRS.includes(wrapper)) return undefined;

  for (const f of files) {
    if (isDir(f)) continue;
    const parts = f.replace(/\\/g, '/').split('/');
    if (parts[0].toLowerCase() !== wrapper) continue;
    if (parts.length === 2 && MOD_ROOT_EXTENSIONS.includes(path.extname(parts[1]).toLowerCase())) {
      return wrapper;
    }
    if (parts.length > 2 && STANDARD_DATA_DIRS.includes(parts[1].toLowerCase())) {
      return wrapper;
    }
  }

  return undefined;
}

// Strips a leading "<wrapper>/" or "<wrapper>\\" segment, if present
function stripWrapperFolder(file, wrapper) {
  if (!wrapper) return file;
  const normalized = file.replace(/\\/g, '/');
  if (!normalized.toLowerCase().startsWith(wrapper + '/')) return file;
  return normalized.slice(wrapper.length + 1);
}

function testForArchives(files, gameId) {
  // Supported for Fallout 76 mods
  const supported = (gameId === GAME_ID);

  return Promise.resolve({
    supported,
    requiredFiles: []
  });
}

function installAndRegisterArchives(files) {
  let instructions = [];

  // Get an array of the file names of the ba2 files (in case they're nested for some reason)    
  const ba2Files = [...new Set(files.filter(f => path.extname(f).toLowerCase() === ARCHIVE_EXT).map(a => path.basename(a)))];
  // Add this attribute to the mod when we install it. 
  if (ba2Files.length) instructions.push({ type: 'attribute', key: 'ba2archives', value: ba2Files });

  // Handle archives whose content lives inside a single wrapper folder with no Data/
  // folder in it (e.g. "SmootherFishing/SmootherFishing.ba2"): treat that folder as
  // the mod root so its contents land directly in the game's Data/ folder.
  const wrapper = detectWrapperFolder(files);

  // Map file copy instructions, stripping any top-level Data/ folder so files land directly in Data/
  const fileInstructions = files.reduce((accum, f) => {
    // Skip directory entries
    if (f.endsWith('/') || f.endsWith('\\')) return accum;

    const destination = sanitizeDestination(stripWrapperFolder(f, wrapper));

    // If destination is empty or just 'data', skip
    if (!destination || destination.toLowerCase() === 'data') return accum;

    accum.push({ type: 'copy', source: f, destination });
    return accum;
  }, []);

  // Combine the attributes and instructions, then return.
  instructions = instructions.concat(fileInstructions);
  return Promise.resolve({ instructions });
}

// NOTE: `const mod` can be undefined when the profile still has data for a modId, but the mod might've been uninstalled
function getBA2Mods(payload, excludeModCondition) {
  const { profile, state, gameId } = payload;
  const BA2Mods = Object.keys(profile.modState).map(modId => {
    if (!excludeModCondition(profile, modId)) return;
    const mod = state.persistent.mods[gameId][modId];
    if (mod && mod?.attributes && mod?.attributes.ba2archives) return mod;
    else return;
  }).filter(m => m !== undefined);

  // Join up all the BA2s into a single array.
  return BA2Mods.map((mod) => mod.attributes.ba2archives.join(',')).join(',').split(',');
}

function updateArchiveList(profile, api) {
  const state = api.store.getState();
  const gameId = profile.gameId;
  const payload = { profile, state, gameId };
  const removeDisabledArchives = util.getSafe(state,
    ['settings', GAME_ID, SETTING_REMOVE_DISABLED], true);

  // 1. Get all BA2s from currently ENABLED mods
  const enabledBA2s = getBA2Mods(payload, (profile, modId) => profile.modState[modId].enabled);

  const gamePath = state.settings?.gameMode?.discovered?.[GAME_ID]?.path;
  if (!gamePath) return;

  const fallout76Custom = path.join(iniPath, fallout76CustomINI);

  return parser.read(fallout76Custom)
    .then((ini) => {
      if (!ini.data || !ini.data.Archive) {
        if (!ini.data) ini.data = {};
        ini.data.Archive = {};
      }

      // 2. Read what's currently in the INI string
      const originalsResourceArchive2List = (ini.data.Archive.sResourceArchive2List || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      let cleanedArchivesList;

      if (removeDisabledArchives) {
        // 3a. Strict mode: Filter the current INI entries against enabled mods only.
        // This removes disabled mods, uninstalled mods, and any manual entries not from enabled mods.
        const filteredOriginals = originalsResourceArchive2List.filter(archive => {
          return enabledBA2s.includes(archive);
        });
        cleanedArchivesList = [...new Set([...enabledBA2s, ...filteredOriginals])].filter(Boolean);
      } else {
        // 3b. Permissive mode: Only remove BA2s from explicitly disabled mods,
        // preserving any other manual entries in the INI.
        const disabledBA2s = getBA2Mods(payload, (profile, modId) => !profile.modState[modId].enabled);
        const filteredOriginals = originalsResourceArchive2List.filter(e => !disabledBA2s.includes(e));
        cleanedArchivesList = [...new Set([...enabledBA2s, ...filteredOriginals])].filter(Boolean);
      }

      ini.data.Archive.sResourceArchive2List = cleanedArchivesList.join(',');
      return parser.write(fallout76Custom, ini).then(() => Promise.resolve())
        .catch(err => log('error', 'Error updating Fallout76Custom.ini', err));
    })
    .catch(err => log('error', 'Error parsing Fallout76Custom.ini', err));
}

// ============================================================================
// HUDModLoader support
// ============================================================================
// HUDModLoader (Fallout 76 Nexus mod 3144) is a HUD framework: it loads every
// HUD widget whose name is listed in the game's Data/hudmodloader.ini. The file
// is a plain list, one widget name per line and no section headers:
//
//     BuffsMeter
//     EventNotifications
//     HUDCondition
//
// A HUD mod installed through Vortex does not add itself to that file, so the
// user has to edit it by hand. This extension maintains the file instead:
//   * a mod that is installed and enabled gets its widget name added (once),
//   * a mod that is uninstalled gets its widget name removed again.
// Lines this table knows nothing about - widget names HUDModLoader ships for mods
// that are not installed, entries added by hand, other HUD loaders - are never
// touched, so a manual setup keeps working.
//
// There is no generic way to know which widget name a mod provides (the author
// picks it and only the mod's own scripts reference it), so the mapping is
// defined once, below, and only needs extending when a new HUD mod is released.

const HUDMODLOADER_INI = 'hudmodloader.ini';

/**
 * Widget names (hudmodloader.ini lines) per mod.
 *
 * line: the widget name exactly as HUDModLoader expects it in the ini.
 * mods: any names the mod can be known by. A mod is known under several names -
 *       its Nexus title, the archive it came in, a name the user gave it - so
 *       the names here are matched loosely: case and punctuation are ignored and
 *       a substring match is used (see hudLinesForMod below).
 *       A mod that ships several widgets has one entry per widget.
 *
 * To support a new HUD mod, add its widget name and mod names to this table.
 */
const HUDMODLOADER_ENTRIES = [
  // Widgets listed as officially supported by HUDModLoader
  { line: 'BuffsMeter', mods: ['Buffs Meter'] },
  { line: 'CompatibleShowHealthRedux', mods: ['Compatible Show Health Redux'] },
  { line: 'CompatibleWeightIndicator', mods: ['Compatible Weight Indicator'] },
  { line: 'CustomCrosshair', mods: ['Custom Crosshair'] },
  { line: 'CustomRadios', mods: ['Custom Radios'] },
  { line: 'DPSMeter', mods: ['Simple DPS Meter', 'DPS Meter'] },
  { line: 'DynamicPingAudio', mods: ['Dynamic Ping Audio'] },
  { line: 'EventNotifications', mods: ['Event Notifications'] },
  { line: 'FFHudMenu', mods: ['Fanfare Free'] },
  { line: 'HUDChallenges', mods: ['HUD Challenges'] },
  { line: 'HUDCondition', mods: ['HUD Condition'] },
  { line: 'HUDEditor', mods: ['HUD Editor'] },
  { line: 'HUDPlayerList', mods: ['HUD Server Player List', 'HUD Player List'] },
  { line: 'ImprovedHealthBars', mods: ['Improved Health Bars', 'Improved HP'] },
  { line: 'KillStreakTimer', mods: ['Kill Streak Timer'] },
  { line: 'PLMHudMenu', mods: ['Perk Loadout Manager'] },
  { line: 'PickUpHistory', mods: ['Pick Up History'] },
  { line: 'StatsMeter', mods: ['Simple Stats Meter', 'Stats Meter'] },
  { line: 'VATSPriority', mods: ['V.A.T.S. Priority', 'VATS Priority'] },
  { line: 'VendorLog', mods: ['Vendor Log'] },

  // "Improved Bars and HUD" ships several widgets in a single mod, so it shows
  // up in one entry per widget and all of its names are added together.
  { line: 'ImprovedBars', mods: ['Improved Bars and HUD', 'Improved HUD', 'Improved Bars'] },
  { line: 'GlowPercent', mods: ['Improved Bars and HUD', 'Improved HUD'] },
  { line: 'HudBarPercentWidgets', mods: ['Improved Bars and HUD', 'Improved HUD'] },

  // Deliberately not mapped: FCMChatWidget and FCMServerBridge belong to
  // "Fallout Chat Mod" as alternative packages of one mod (the mod page says to
  // install only one of them). Matching the mod would add both names, which the
  // mod forbids, so their lines are simply left untouched.
];

// "HUD Condition - Armor and weapon" -> "hudconditionarmorandweapon".
// Used so names match regardless of case, spaces, dots and dashes.
function normalizeHudName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * All names a single mod can be known by, used to match it against
 * HUDMODLOADER_ENTRIES.
 */
function getModNameCandidates(mod) {
  const attributes = (mod && mod.attributes) || {};

  const candidates = [
    attributes.customFileName,   // name the user gave the mod in Vortex
    attributes.logicalFileName,  // name Vortex derived from the download
    attributes.modName,
    attributes.name,
    mod && mod.installationPath, // staging folder, e.g. "Event Notifications 4104 1.0.5 ..."
  ];

  // Every archive this extension saw while installing the mod (see
  // installAndRegisterArchives). HUD mods usually ship one .ba2 named after the
  // widget it loads - "EventNotifications.ba2" - which is a very reliable match.
  for (const archive of attributes.ba2archives || []) {
    candidates.push(path.basename(archive, path.extname(archive)));
  }

  return candidates.filter(c => (typeof c === 'string') && (c.length > 0));
}

/**
 * The hudmodloader.ini widget names a single mod needs.
 *
 * Matching is a substring test on normalized names. The aliases in
 * HUDMODLOADER_ENTRIES are specific enough that a false positive is not a
 * concern in practice, and an extra widget name in the ini only makes
 * HUDModLoader look for a widget that is not installed, which it ignores.
 */
function hudLinesForMod(mod) {
  const names = getModNameCandidates(mod).map(normalizeHudName).filter(Boolean);
  if (names.length === 0) return [];

  const lines = [];
  for (const entry of HUDMODLOADER_ENTRIES) {
    const aliases = [entry.line].concat(entry.mods).map(normalizeHudName);
    const matches = aliases.some(alias => names.some(name => name.includes(alias)));
    if (matches) lines.push(entry.line);
  }
  return lines;
}

/**
 * Widget names required by all mods that are installed *and* enabled in the
 * given profile.
 */
function getRequiredHudLines(state, profile) {
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const modState = (profile && profile.modState) || {};
  const lines = [];

  for (const modId of Object.keys(modState)) {
    if (!modState[modId] || !modState[modId].enabled) continue;
    // modState can outlive the mod record (uninstalled mod) - nothing to add then
    const mod = mods[modId];
    if (!mod) continue;
    for (const line of hudLinesForMod(mod)) {
      if (!lines.includes(line)) lines.push(line);
    }
  }

  return lines;
}

/**
 * Splits a hudmodloader.ini into lines while remembering how it was formatted,
 * so rewriting it does not change the user's line endings or add/remove a BOM.
 */
function readHudIni(content) {
  const hasBom = content.charCodeAt(0) === 0xFEFF;
  const body = hasBom ? content.slice(1) : content;
  const lines = body.length > 0 ? body.split(/\r?\n/) : [];
  const endsWithNewline = body.endsWith('\n');
  // A trailing newline produces an empty last element, which is not a line
  if (endsWithNewline) lines.pop();

  return {
    hasBom,
    eol: body.includes('\r\n') ? '\r\n' : '\n',
    endsWithNewline,
    lines,
  };
}

function writeHudIni(doc, lines) {
  const body = lines.join(doc.eol)
    + ((doc.endsWithNewline && (lines.length > 0)) ? doc.eol : '');
  return (doc.hasBom ? '\uFEFF' : '') + body;
}

/**
 * Adds widget names that are not in the file yet. Everything already in the
 * file - lines HUDModLoader ships itself, lines the user added, duplicates - is
 * left exactly as it was, so a name is never listed twice.
 *
 * Pure function, which lets the behaviour be tested outside Vortex (test/).
 */
function addHudLines(content, linesToAdd) {
  const doc = readHudIni(content);
  const present = new Set(doc.lines.map(normalizeHudName));
  const added = [];

  for (const line of linesToAdd) {
    const key = normalizeHudName(line);
    if (!key || present.has(key)) continue;
    doc.lines.push(line);
    present.add(key);
    added.push(line);
  }

  return { content: added.length ? writeHudIni(doc, doc.lines) : content, added };
}

/**
 * Removes the given widget names from the file. Lines that are not in the given
 * list (widget names this extension does not know about, manual additions) are
 * preserved untouched.
 *
 * Pure function, which lets the behaviour be tested outside Vortex (test/).
 */
function removeHudLines(content, linesToRemove) {
  const doc = readHudIni(content);
  const targets = new Set(linesToRemove.map(normalizeHudName));
  const removed = [];

  const kept = doc.lines.filter(line => {
    if (!targets.has(normalizeHudName(line))) return true;
    removed.push(line.trim());
    return false;
  });

  return { content: removed.length ? writeHudIni(doc, kept) : content, removed };
}

/**
 * Brings the widget list in line with the installed mods: adds the names of
 * enabled mods and drops the names of uninstalled ones.
 *
 * `prunedLines` are the names remembered for uninstalled mods (see
 * captureHudLinesForRemoval). A name that is required again - the mod was
 * reinstalled - is not pruned.
 *
 * Pure function, which lets the behaviour be tested outside Vortex (test/).
 */
function reconcileHudLines(content, requiredLines, prunedLines) {
  const required = new Set(requiredLines.map(normalizeHudName));
  const toRemove = prunedLines.filter(line => !required.has(normalizeHudName(line)));

  const removedResult = removeHudLines(content, toRemove);
  const addedResult = addHudLines(removedResult.content, requiredLines);

  return {
    content: addedResult.content,
    added: addedResult.added,
    removed: removedResult.removed,
  };
}

/** Data/hudmodloader.ini of the managed game installation, if known. */
function hudModLoaderIniPath(state) {
  const gamePath = util.getSafe(state,
    ['settings', 'gameMode', 'discovered', GAME_ID, 'path'], undefined);
  // HUDModLoader keeps both its .ba2 and its ini in the game's Data folder
  return gamePath ? path.join(gamePath, 'Data', HUDMODLOADER_INI) : undefined;
}

/**
 * Reads Data/hudmodloader.ini, hands its content to `edit` and writes the result
 * back if it actually changed. Returns whatever `edit` returned, so the caller
 * can report what was added/removed.
 *
 * The file is only touched when it exists: HUDModLoader (or the user) creates
 * it, so a missing file means the loader is not installed or not deployed and
 * there is nothing to manage here.
 */
async function editHudModLoaderIni(api, edit) {
  const state = api.store.getState();
  const iniFile = hudModLoaderIniPath(state);
  if (!iniFile) return undefined;

  let content;
  try {
    content = await fs.readFileAsync(iniFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('error', `Could not read ${HUDMODLOADER_INI}`, err);
    }
    return undefined;
  }

  const result = edit(content);
  if (result.content !== content) {
    try {
      await fs.writeFileAsync(iniFile, result.content, 'utf8');
    } catch (err) {
      log('error', `Could not update ${HUDMODLOADER_INI}`, err);
      api.sendNotification({
        id: 'fallout76-hudmodloader-error',
        type: 'error',
        title: `Could not update ${HUDMODLOADER_INI}`,
        message: `${err.code} - ${err.message}`,
      });
    }
  }

  return result;
}

/**
 * Widget names of mods that were uninstalled. HUDModLoader ships its ini with a
 * line for every mod it supports, and a deployment copies that file into the game
 * folder again, so a name would come back with the next deployment if it was
 * only deleted once. Keeping the name here makes the removal stick until the mod
 * is installed again.
 */
function getPrunedHudLines(state) {
  return util.getSafe(state, ['settings', GAME_ID, SETTING_HUDMODLOADER_PRUNED], []);
}

/**
 * Makes sure every installed and enabled mod this extension knows about is
 * listed in Data/hudmodloader.ini, and that uninstalled ones are not.
 *
 * Runs on startup, when the profile changes and after a deployment (a deployment
 * overwrites the file with the copy that ships with HUDModLoader).
 */
async function updateHudModLoaderIni(profile, api) {
  if (!profile || profile.gameId !== GAME_ID) return;

  const state = api.store.getState();
  const requiredLines = getRequiredHudLines(state, profile);
  const prunedLines = getPrunedHudLines(state);

  const result = await editHudModLoaderIni(
    api, content => reconcileHudLines(content, requiredLines, prunedLines));

  if (result && (result.added.length > 0)) {
    log('info', `Added HUD mod(s) to ${HUDMODLOADER_INI}: ${result.added.join(', ')}`);
  }
  if (result && (result.removed.length > 0)) {
    log('info', `Removed HUD mod(s) from ${HUDMODLOADER_INI}: ${result.removed.join(', ')}`);
  }
}

/**
 * "will-remove-mod": remember the widget names of the mod Vortex is about to
 * uninstall. The mod record is gone once the removal has finished, so this has
 * to happen while the mod still exists.
 */
function captureHudLinesForRemoval(gameId, modId, removeOpts, api) {
  if (gameId !== GAME_ID) return;
  // A reinstall/update ("will be replaced") keeps the mod, only its files change
  if (removeOpts && removeOpts.willBeReplaced) return;

  const state = api.store.getState();
  const mod = util.getSafe(state, ['persistent', 'mods', GAME_ID, modId], undefined);
  if (!mod) return;

  const lines = hudLinesForMod(mod);
  if (lines.length === 0) return;

  // Stored in the extension settings so it survives a Vortex restart
  const remembered = [...new Set(getPrunedHudLines(state).concat(lines))];
  api.store.dispatch({ type: 'FO76_SET_HUDMODLOADER_PRUNED', payload: remembered });
}

/** The profile of the active game, if Fallout 76 is the game being managed. */
function getActiveGameProfile(state) {
  const profileId = selectors.activeProfileId(state);
  const profile = util.getSafe(state, ['persistent', 'profiles', profileId], undefined);
  return (profile && (profile.gameId === GAME_ID)) ? profile : undefined;
}

/**
 * Refreshes everything this extension maintains for the game:
 * the archive list in Fallout76Custom.ini (Documents) and the HUDModLoader
 * widget list in Data/hudmodloader.ini (game folder).
 */
function updateManagedIniFiles(profile, api) {
  return Promise.all([
    updateArchiveList(profile, api),
    updateHudModLoaderIni(profile, api),
  ]);
}

/**
 * Using the onStateChange props, this function checks for the profile that has changed and returns it
 * @param {*} previous 
 * @param {*} current 
 * @returns the changed profile
 */
function getChangedProfile(previous, current) {
  if ((previous === undefined) || (current === undefined)) {
    return;
  }
  const profileIds = Object.keys(previous)
  for (let i = 0; i < profileIds.length; i++) {
    const profileId = profileIds[i];
    if ((previous[profileId] !== current[profileId]) && (current[profileId] !== undefined)) {
      return current[profileId]
    }
  }
}

let debounceUpdate = setTimeout(() => { }, 0);

function debouncedUpdateIniFiles(previous, current, api) {
  const changedProfile = getChangedProfile(previous, current)
  // Ensure that the profile, the modstate and the gameid are correct
  if (!changedProfile || !changedProfile.modState || changedProfile.gameId !== GAME_ID) {
    // Return if no profile, or the profile is not for FO76
    return
  }
  updateManagedIniFiles(changedProfile, api)
}

function findExecutable(discoveryPath) {
  const steamExe = 'Fallout76.exe';
  const xboxExe = 'Project76_GamePass.exe';

  if (!discoveryPath) return steamExe;

  try {
    // Steam version
    fs.statSync(path.join(discoveryPath, steamExe));
    return steamExe;
  }
  catch (err) {
    // Could not stat to Steam path
  }

  try {
    //Xbox version
    fs.statSync(path.join(discoveryPath, xboxExe));
    return xboxExe;
  }
  catch (err) {
    // Could not stat the Xbox path
  }

  log('error', 'Neither the Steam or Xbox EXE paths exist for Fallout 76');
  return steamExe;
  // throw new Error('Neither the Steam or Xbox EXE paths exist for Fallout 76');
}

function main(context) {
  context.requireVersion('>=1.2.0');

  // Register reducer FIRST for settings persistence
  context.registerReducer(['settings', GAME_ID], settingsReducer);

  context.registerGame({
    id: GAME_ID,
    name: 'Fallout 76',
    mergeMods: true,
    queryPath: findGame,
    supportedTools: tools,
    queryModPath: () => 'data',
    setup: () => onGameModeActivated(GAME_ID, context.api),
    logo: path.join('assets', 'gameart.jpg'),
    executable: findExecutable,
    requiredFiles: ['Data'],
    environment: {
      SteamAPPId: STEAM_APP_ID,
    },
    details: {
      steamAppId: STEAM_APP_ID,
    }
  });

  // We'll use an installer to save a list of included BA2 files to the mod.
  context.registerInstaller('fallout76-installer', 25, testForArchives, installAndRegisterArchives);

  // Migrate from a version below 2.0.0 - not tested but it should work. 
  context.registerMigration(old => migrate200(context.api, old));

  // Register settings panel (visible only when FO76 is the active game)
  context.registerSettings('Mods', Settings, undefined, () => {
    const state = context.api.getState();
    return selectors.activeGameId(state) === GAME_ID;
  }, 150);

  context.once(() => {
    const state = context.api.store.getState();
    const activeGameId = selectors.activeGameId(state);

    if (activeGameId === GAME_ID) {
      onGameModeActivated(activeGameId, context.api);
    }

    // When we activate Fallout 76, make sure the custom INI exists.
    context.api.events.on('gamemode-activated', (gameId) => onGameModeActivated(gameId, context.api));

    // On profile state change update the list of BA2s
    context.api.onStateChange(['persistent', 'profiles'],
      (previous, current) => {
        clearTimeout(debounceUpdate)
        debounceUpdate = setTimeout(() => {
          debouncedUpdateIniFiles(previous, current, context.api)
        }, 500);
      });

    // Deployments (manual "Apply" or automatic) don't change the profile, so the
    // onStateChange handler above never fires for them. Vortex emits "did-deploy"
    // (via emitAndAwait) once deployment has finished, which is our cue to refresh
    // both ini files - a deployment also restores HUDModLoader's own
    // hudmodloader.ini, which still lists the mods we removed names for.
    context.api.onAsync('did-deploy', async (profileId) => {
      const state = context.api.store.getState();
      const profile = state.persistent.profiles[profileId];
      if (profile && (profile.gameId === GAME_ID)) {
        await updateManagedIniFiles(profile, context.api);
      }
    });

    // HUDModLoader widget list (Data/hudmodloader.ini): remember which widget
    // names an uninstalled mod needed, then remove them once the mod is gone.
    context.api.events.on('will-remove-mod', (gameId, modId, removeOpts) =>
      captureHudLinesForRemoval(gameId, modId, removeOpts, context.api));

    context.api.events.on('did-remove-mod', (gameId) => {
      if (gameId !== GAME_ID) return;
      const profile = getActiveGameProfile(context.api.store.getState());
      if (profile) {
        updateHudModLoaderIni(profile, context.api)
          .catch(err => log('error', `Error updating ${HUDMODLOADER_INI}`, err));
      }
    });
  });

  return true;
}

function migrate200(api, oldVersion) {
  // If the oldVersion is greater than or equal to 2.0.0, do nothing.
  if (semver.gte(oldVersion || '0.0.1', '2.0.0')) return Promise.resolve();

  const state = api.store.getState();
  const activatorId = selectors.activatorForGame(state, GAME_ID);
  const activator = util.getActivator(activatorId);
  const discovery = util.getSafe(state, ['settings', 'gameMode', 'discovered', GAME_ID], undefined);
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], undefined);

  // If we're not managed Fallout 76 yet, do nothing.
  if (!discovery || !discovery.path || !activator) return Promise.resolve();

  // If we're not managing mods for Fallout 76, do nothing.
  if (mods === undefined || Object.keys(mods).length === 0) return Promise.resolve();

  const stagingFolder = selectors.installPath(api.getState());

  // Wait for the UI to load.
  return api.awaitUI()
    .then(() => {
      const modArray = Object.keys(mods).map(k => mods[k]);
      // Interate through each mod to check for BA2 archives.
      return Promise.all(modArray.map(mod => {
        return new Promise((resolve, reject) => {
          const modPath = path.join(stagingFolder, mod.installationPath);
          let ba2archives = [];
          // Walk through all files for this mod, adding BA2s to the array.
          util.walk(modPath, (iterPath, stats) => {
            if (path.extname(iterPath) === ARCHIVE_EXT) {
              return ba2archives.push(path.basename(iterPath));
            }
          })
            // If we collected some BA2s, set the mod attribute.
            .then(() => ba2archives.length ? api.store.dispatch(actions.setModAttribute(GAME_ID, mod.id, 'ba2archives', ba2archives)) : undefined)
        });
      }))
    })

}

module.exports = {
  default: main,
  // Exposed for the automated install-layout tests (test/); not used by Vortex.
  _installPaths: { sanitizeDestination, detectWrapperFolder, stripWrapperFolder },
  // Exposed for the automated HUDModLoader tests (test/hudmodloader.test.js).
  _hudModLoader: {
    SETTING_HUDMODLOADER_PRUNED,
    HUDMODLOADER_ENTRIES,
    normalizeHudName,
    getModNameCandidates,
    hudLinesForMod,
    getRequiredHudLines,
    addHudLines,
    removeHudLines,
    reconcileHudLines,
    getPrunedHudLines,
    updateHudModLoaderIni,
    captureHudLinesForRemoval,
    getActiveGameProfile,
  },
};
