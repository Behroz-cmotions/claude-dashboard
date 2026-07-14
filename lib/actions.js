const fs = require('fs');
const path = require('path');

// Een pad is toegestaan als het, na resolve (dus na het wegwerken van ..),
// binnen een van de roots ligt. De separator-check voorkomt dat
// "C:\claude-evil" doorgaat voor een kind van "C:\claude".
function isAllowedPath(target, roots) {
  if (!target || typeof target !== 'string') return false;
  const resolved = path.resolve(target);
  return roots.some((root) => {
    const r = path.resolve(root);
    if (resolved === r) return true;
    return resolved.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
}

function assertAllowed(target, roots) {
  if (!isAllowedPath(target, roots)) {
    throw new Error('path is outside the allowed folders: ' + target);
  }
  return path.resolve(target);
}

function readFileSafe(target, roots) {
  const p = assertAllowed(target, roots);
  return fs.readFileSync(p, 'utf8');
}

function saveFile(target, content, roots) {
  const p = assertAllowed(target, roots);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function deletePath(target, roots) {
  const p = assertAllowed(target, roots);
  fs.rmSync(p, { recursive: true, force: false });
  return p;
}

// Verwijdert één hook uit een settings.json en laat de rest van het bestand intact.
// Index-gebaseerd: het commando gaat gemaskeerd naar de browser en is dus geen
// betrouwbare sleutel.
function removeHook(settingsPath, event, groupIndex, hookIndex, roots) {
  const p = assertAllowed(settingsPath, roots);
  const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
  const groups = settings.hooks && settings.hooks[event];
  if (!Array.isArray(groups)) throw new Error('event not found: ' + event);

  const group = groups[groupIndex];
  if (!group || !Array.isArray(group.hooks) || !group.hooks[hookIndex]) {
    throw new Error('hook not found at position ' + groupIndex + '/' + hookIndex);
  }
  const removed = group.hooks[hookIndex];
  group.hooks.splice(hookIndex, 1);

  settings.hooks[event] = groups.filter((g) => (g.hooks || []).length > 0);
  if (!settings.hooks[event].length) delete settings.hooks[event];

  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { path: p, command: removed.command || removed.type || '' };
}

function createFile(target, content, roots) {
  const p = assertAllowed(target, roots);
  if (fs.existsSync(p)) throw new Error('already exists: ' + p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// Voegt een hook toe aan een settings.json; maakt het bestand aan als het nog
// niet bestaat en laat alle andere instellingen intact.
function addHook(settingsPath, event, matcher, command, roots) {
  const p = assertAllowed(settingsPath, roots);
  if (!event) throw new Error('event is required');
  if (!command) throw new Error('command is required');
  let settings = {};
  if (fs.existsSync(p)) {
    settings = JSON.parse(fs.readFileSync(p, 'utf8'));
  } else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const group = { hooks: [{ type: 'command', command }] };
  if (matcher) group.matcher = matcher;
  settings.hooks[event].push(group);
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return p;
}

module.exports = { isAllowedPath, assertAllowed, readFileSafe, saveFile, deletePath, removeHook, createFile, addHook };
