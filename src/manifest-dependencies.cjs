'use strict';

const MANIFEST = /(?:^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|composer\.json|Gemfile)$/i;
const FIELD = /["']?(?:dependencies|devDependencies|optionalDependencies|peerDependencies|require|require-dev)["']?\s*[:=]/i;
const REQUIREMENT = /^\s*[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[^\]\r\n]+\])?\s*(?:(?:===|==|~=|!=|<=|>=|<|>|@)\s*\S+)?(?:\s*;.*)?\s*$/;

function dependencySection(filePath, section) {
  const file = String(filePath || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  return file === 'cargo.toml'
    ? /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)(?:\.|$)/.test(section)
    : file === 'pyproject.toml' && /(?:^|\.)(?:dependencies|dev-dependencies|optional-dependencies)(?:\.|$)/.test(section);
}

function jsonDeclarations(filePath, content, fragment) {
  if (!/(?:^|\/)(?:package|composer)\.json$/i.test(String(filePath || '').replace(/\\/g, '/'))) return null;
  let manifest;
  try { manifest = JSON.parse(String(content)); } catch { return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'require', 'require-dev'];
  // Native edits can supply only a dependency map, without its enclosing field.
  // Keep the existing version hints, comparing entries so removals can continue.
  if (fragment && !fields.some(field => Object.hasOwn(manifest, field))) {
    return Object.entries(manifest)
      .filter(([, version]) => typeof version === 'string' && /(?:==|>=|~=|\^\d)/.test(version))
      .map(entry => JSON.stringify(entry));
  }
  const declarations = [];
  for (const field of fields) {
    const entries = manifest[field];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [name, version] of Object.entries(entries)) declarations.push(JSON.stringify([field, name, version]));
  }
  return declarations;
}

function fragmentHeader(content) {
  const lines = String(content || '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  return lines.length === 1 ? /^\[([^\]]+)\](?:\s*#.*)?$/.exec(lines[0]) : null;
}

// Resolve declaration roles before comparing old and new fragments. A line
// moved out of metadata becomes a dependency even when its text stays the same.
// These are syntax hints from the supplied tool input, not a full manifest diff.
function dependencyLines(filePath, content, fragment = false) {
  const match = MANIFEST.exec(String(filePath || '').replace(/\\/g, '/'));
  if (!match) return [];
  const json = jsonDeclarations(filePath, content, fragment);
  if (json) return json;
  const file = match[1].toLowerCase();
  let section = '';
  let dependencyBlock = false;
  const declarations = [];
  for (const text of String(content || '').split(/\r?\n/)) {
    const line = text.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) section = header[1];
    let declaration = false;
    if (file.startsWith('requirements')) {
      declaration = REQUIREMENT.test(line.replace(/\s+#.*$/, ''));
    } else if (file === 'cargo.toml') {
      declaration = dependencySection(filePath, section)
        && /^[\w-]+\s*=\s*(?:["']|\{)/.test(line);
    } else if (file === 'go.mod') {
      declaration = /^(?:require\s+)?[A-Za-z0-9_.\/-]+\s+v\d/.test(line);
    } else if (file === 'gemfile') {
      declaration = /^gem\s+["']/.test(line);
    } else {
      const field = FIELD.test(line);
      declaration = field || (dependencyBlock && /^["'][^"']+["']/.test(line));
      if (file === 'pyproject.toml') {
        declaration ||= dependencySection(filePath, section)
          && /^[\w"'-]+\s*=/.test(line);
      }
      if (field) dependencyBlock = /[\[{]/.test(line) && !/[\]}]\s*,?\s*$/.test(line);
      else if (/^[\]}]/.test(line) || header) dependencyBlock = false;
    }
    // Preserve version hints for native fragments that omit their section.
    if (fragment && !section && /(?:==|>=|~=|\^\d)/.test(line)) declaration = true;
    if (declaration) declarations.push(line.replace(/,\s*$/, ''));
  }
  return declarations;
}

function manifestDependencyIntent(filePath, content) {
  return dependencyLines(filePath, content).length > 0;
}

function manifestEditDependencyIntent(filePath, oldText, newText) {
  // A header-only edit can reclassify entries outside the supplied fragment.
  // Merely appending an empty table, or moving dependencies back to metadata,
  // does not introduce a dependency declaration.
  const oldHeader = fragmentHeader(oldText);
  const newHeader = fragmentHeader(newText);
  if (oldHeader && newHeader && !dependencySection(filePath, oldHeader[1])
      && dependencySection(filePath, newHeader[1])) return true;
  const remaining = new Map();
  for (const key of dependencyLines(filePath, oldText, true)) {
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  for (const key of dependencyLines(filePath, newText, true)) {
    const count = remaining.get(key) || 0;
    if (!count) return true;
    remaining.set(key, count - 1);
  }
  return false;
}

function patchDependencyIntent(patch) {
  let filePath = '';
  let before = [];
  let after = [];
  const addedDependency = () => manifestEditDependencyIntent(filePath, before.join('\n'), after.join('\n'));
  for (const line of String(patch || '').split(/\r?\n/)) {
    const header = /^\*\*\*\s*(?:Add|Update)\s+File:\s*(.+?)\s*$/.exec(line);
    if (header || /^\*\*\*/.test(line)) {
      if (addedDependency()) return true;
      filePath = header ? header[1] : '';
      before = []; after = [];
    } else if (line.startsWith('@@')) {
      // Separate hunks have no guaranteed intervening section context.
      if (addedDependency()) return true;
      before = []; after = [];
      if (line.slice(2).trim()) { before.push(line.slice(2).trim()); after.push(line.slice(2).trim()); }
    } else {
      if (/^[- ]/.test(line)) before.push(line.slice(1));
      if (/^[+ ]/.test(line)) after.push(line.slice(1));
    }
  }
  return addedDependency();
}

module.exports = { manifestDependencyIntent, manifestEditDependencyIntent, patchDependencyIntent };
