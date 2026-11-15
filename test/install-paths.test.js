'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

// index.js pulls in the Vortex runtime (vortex-api, react, winapi-bindings, ...)
// which only exists inside Vortex. Stub every external module so the file can be
// required in plain Node; the install-path logic under test is pure.
const stubs = {
  'vortex-api': {
    actions: {},
    fs: {},
    util: { getVortexPath: () => 'documents' },
    selectors: {},
    log: { warn: () => {}, error: () => {} },
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

const { _installPaths } = require(path.join(__dirname, '..', 'index.js'));
Module._load = originalLoad;

const { sanitizeDestination, detectWrapperFolder, stripWrapperFolder } = _installPaths;

// Replays the installer's destination pipeline for a whole archive listing:
// detect a wrapper folder once, then strip it + sanitize each file.
function destinations(files) {
  const wrapper = detectWrapperFolder(files);
  return files
    .filter((f) => !(f.endsWith('/') || f.endsWith('\\')))
    .map((f) => sanitizeDestination(stripWrapperFolder(f, wrapper)));
}

test('XSCAL loader mod: functional top-level folder is kept', () => {
  const files = [
    'XSCAL/',
    'XSCAL/Plugins/',
    'XSCAL/Plugins/BrowserHistory_lang.json',
    'XSCAL/Plugins/Fallout76_BrowserHistory.dll',
    'XSCAL/Plugins/Fallout76_BrowserHistory.dll.sig',
  ];
  assert.deepEqual(destinations(files), [
    'XSCAL/Plugins/BrowserHistory_lang.json',
    'XSCAL/Plugins/Fallout76_BrowserHistory.dll',
    'XSCAL/Plugins/Fallout76_BrowserHistory.dll.sig',
  ]);
});

test('single wrapper folder with ba2: stripped (SmootherFishing case)', () => {
  assert.deepEqual(destinations(['SmootherFishing/', 'SmootherFishing/SmootherFishing.ba2']),
    ['SmootherFishing.ba2']);
});

test('root readme + single wrapper folder: readme kept, wrapper stripped', () => {
  assert.deepEqual(destinations(['readme.txt', 'SmootherFishing/SmootherFishing.ba2']),
    ['readme.txt', 'SmootherFishing.ba2']);
});

test('wrapper folder with ba2 and standard Data subfolder: stripped', () => {
  assert.deepEqual(destinations(['MyMod/MyMod.ba2', 'MyMod/textures/foo.dds']),
    ['MyMod.ba2', 'textures/foo.dds']);
});

test('wrapper folder with only an esm: stripped', () => {
  assert.deepEqual(destinations(['MyMod/', 'MyMod/MyMod.esm']), ['MyMod.esm']);
});

test('wrapper folder with only an ini: stripped', () => {
  assert.deepEqual(destinations(['MyMod/', 'MyMod/config.ini']), ['config.ini']);
});

test('bare ba2 at archive root: unchanged', () => {
  assert.deepEqual(destinations(['SomeMod.ba2']), ['SomeMod.ba2']);
});

test('Data folder: Data prefix stripped', () => {
  assert.deepEqual(destinations(['Data/', 'Data/Mod.ba2', 'Data/textures/foo.dds']),
    ['Mod.ba2', 'textures/foo.dds']);
});

test('nested Data/Data: both prefixes stripped', () => {
  assert.deepEqual(destinations(['Data/Data/Mod.ba2']), ['Mod.ba2']);
});

test('wrapper folder wrapping Data/: both levels stripped', () => {
  assert.deepEqual(destinations(['ModFolder/', 'ModFolder/Data/Mod.ba2']), ['Mod.ba2']);
});

test('standard Data subfolders keep their structure', () => {
  assert.deepEqual(destinations(['interface/foo.swf', 'textures/bar.dds']),
    ['interface/foo.swf', 'textures/bar.dds']);
});

test('multiple top-level folders (e.g. MCM + interface): untouched', () => {
  assert.deepEqual(destinations(['MCM/config.json', 'interface/foo.swf']),
    ['MCM/config.json', 'interface/foo.swf']);
});

test('two content folders: untouched (no risky blanket stripping)', () => {
  assert.deepEqual(destinations(['ModA/a.ba2', 'ModB/b.ba2']), ['ModA/a.ba2', 'ModB/b.ba2']);
});

test('wrapper detection is case-insensitive', () => {
  assert.deepEqual(destinations(['SmootherFishing/SmootherFishing.BA2']),
    ['SmootherFishing.BA2']);
  assert.deepEqual(destinations(['Data/Mod.ba2']), ['Mod.ba2']);
});

test('backslash-separated archive paths are handled', () => {
  assert.deepEqual(destinations(['SmootherFishing\\SmootherFishing.ba2']),
    ['SmootherFishing.ba2']);
  assert.deepEqual(destinations(['XSCAL\\Plugins\\Fallout76_BrowserHistory.dll']),
    ['XSCAL\\Plugins\\Fallout76_BrowserHistory.dll']);
});

test('known trade-off: wrapper with ba2 at root AND a functional subfolder flattens both', () => {
  // A single top-level folder whose root level holds a .ba2 wins the strip, so a
  // nested functional folder (e.g. Plugins/) gets flattened too. Vanishingly rare;
  // documented here so a future change of this behavior is a conscious decision.
  assert.deepEqual(destinations(['MyMod/MyMod.ba2', 'MyMod/Plugins/x.dll']),
    ['MyMod.ba2', 'Plugins/x.dll']);
});

test('detectWrapperFolder: data and standard dirs are never wrappers', () => {
  assert.equal(detectWrapperFolder(['Data/Mod.ba2']), undefined);
  assert.equal(detectWrapperFolder(['textures/foo.dds']), undefined);
  // Two different top-level folders -> no single wrapper
  assert.equal(detectWrapperFolder(['a/x.ba2', 'b/textures/x.dds']), undefined);
});

test('detectWrapperFolder: folder with only non-standard subfolders is functional', () => {
  assert.equal(detectWrapperFolder(['XSCAL/Plugins/x.dll']), undefined);
});

test('stripWrapperFolder: non-matching paths pass through untouched', () => {
  assert.equal(stripWrapperFolder('Other/Mod.ba2', 'mymod'), 'Other/Mod.ba2');
  assert.equal(stripWrapperFolder('Mod.ba2', 'mymod'), 'Mod.ba2');
  assert.equal(stripWrapperFolder('MyMod/Mod.ba2', undefined), 'MyMod/Mod.ba2');
});

test('sanitizeDestination: leading slashes normalized, lone Data removed by the installer', () => {
  assert.equal(sanitizeDestination('/leading/file.txt'), 'leading/file.txt');
  assert.equal(sanitizeDestination('\\leading\\file.txt'), 'leading\\file.txt');
});
