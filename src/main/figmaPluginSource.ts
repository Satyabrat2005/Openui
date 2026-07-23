/**
 * figmaPluginSource.ts — the OpenUI Builder plugin, as source text.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONLY WAY TO WRITE TO A FIGMA FILE
 *
 * The Figma REST API cannot create or edit file content — see the WRITE ACCESS
 * note in figma.ts. Authoring requires code running INSIDE Figma against the
 * `figma.*` scene-graph API. That is what this file emits: a small plugin the
 * user imports once, which then builds whatever OpenUI sends it.
 *
 * ARCHITECTURE — why two files and not one:
 *
 * A Figma plugin has two threads, and the split is not optional:
 *
 *   code.js  (main)  — has `figma.*`, the scene graph, the document.
 *                      Has NO fetch. Cannot talk to the network at all.
 *   ui.html  (iframe)— has fetch/XHR like any browser page.
 *                      Has NO access to `figma.*` or the document.
 *
 * So the bridge has to be: ui.html polls OpenUI over localhost → relays the job
 * to code.js via postMessage → code.js builds it → posts the result back to
 * ui.html → ui.html POSTs it to OpenUI. Any design that has code.js fetching
 * directly is impossible, and any design that has ui.html touching the document
 * is impossible.
 *
 * The UI is a real (tiny) window rather than `figma.showUI(..., {visible:false})`
 * because the user needs to see that the bridge is connected, and because a
 * visible window is what keeps the plugin alive and polling between builds.
 * That is what makes the second and every later build fully hands-off.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Emitted as strings rather than shipped as static assets because the bridge
 * port and auth token are baked in at generation time — the manifest's
 * networkAccess.allowedDomains must name the exact origin, so it cannot be
 * written before we know which port we bound.
 */

export const PLUGIN_DIR_NAME = 'openui-figma-builder'

/**
 * manifest.json. `allowedDomains` must list the exact origin — Figma rejects a
 * fetch to anything not named here, and it does not accept a port wildcard, so
 * every port the bridge might bind to is listed.
 */
export function pluginManifest(ports: number[]): string {
  return (
    JSON.stringify(
      {
        name: 'OpenUI Builder',
        id: 'openui-builder-local',
        api: '1.0.0',
        main: 'code.js',
        ui: 'ui.html',
        editorType: ['figma'],
        networkAccess: {
          allowedDomains: ports.map((p) => `http://127.0.0.1:${p}`),
          // Imported-from-manifest plugins run in development mode, where Figma
          // consults this list instead. Same origins rather than the "*" the
          // docs permit for dev — there is no reason to widen it.
          devAllowedDomains: ports.map((p) => `http://127.0.0.1:${p}`),
          reasoning:
            'Receives design build jobs from the OpenUI desktop app running on this machine. ' +
            'Localhost only — no external servers are contacted.'
        }
      },
      null,
      2
    ) + '\n'
  )
}

/**
 * ui.html — the network half of the bridge.
 *
 * Polls for work, relays it to the scene-graph thread, reports the outcome
 * back. Deliberately dependency-free and inline: a Figma plugin UI cannot load
 * external scripts, and this must run offline.
 */
export function pluginUiHtml(ports: number[], token: string): string {
  return `<!DOCTYPE html>
<meta charset="utf-8">
<style>
  body { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         margin: 0; padding: 12px; color: #333; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #bbb; flex: none; }
  .dot.on  { background: #14ae5c; }
  .dot.err { background: #f24822; }
  .title { font-weight: 600; }
  #log { font: 11px ui-monospace, Menlo, Consolas, monospace; color: #666;
         white-space: pre-wrap; max-height: 120px; overflow-y: auto;
         background: #f5f5f5; border-radius: 4px; padding: 8px; }
</style>
<div class="row"><span class="dot" id="dot"></span><span class="title">OpenUI Builder</span></div>
<div class="row" id="status">Connecting to OpenUI…</div>
<div id="log"></div>
<script>
  var PORTS = ${JSON.stringify(ports)};
  var TOKEN = ${JSON.stringify(token)};
  var POLL_MS = 1000;
  var BASE = null;          // resolved by discover(), below
  var busy = false;
  var failures = 0;

  var dot = document.getElementById('dot');
  var statusEl = document.getElementById('status');
  var logEl = document.getElementById('log');

  function log(line) {
    logEl.textContent = (new Date().toLocaleTimeString() + '  ' + line + '\\n' + logEl.textContent).slice(0, 4000);
  }
  function setStatus(text, state) {
    statusEl.textContent = text;
    dot.className = 'dot' + (state ? ' ' + state : '');
  }

  // Find which port OpenUI came up on.
  //
  // The plugin is imported once and lives for months, but OpenUI restarts all
  // the time and may land on a different port when something else has taken the
  // first choice. Baking one port into this file would mean a silently dead
  // plugin after any such restart, so instead we probe the declared range for
  // whichever one answers /health. Every candidate is in the manifest's
  // allowedDomains, so any of them is fetchable.
  function discover() {
    var attempts = PORTS.map(function (p) {
      return fetch('http://127.0.0.1:' + p + '/health')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return d && d.service === 'openui-figma-bridge' ? p : null; })
        .catch(function () { return null; });
    });
    return Promise.all(attempts).then(function (found) {
      for (var i = 0; i < found.length; i++) {
        if (found[i]) return 'http://127.0.0.1:' + found[i];
      }
      return null;
    });
  }

  // Poll for work. A failure here is normal — OpenUI may not be running yet —
  // so it degrades to a quiet "waiting" rather than an error spiral.
  function poll() {
    if (busy) { setTimeout(poll, POLL_MS); return; }

    if (!BASE) {
      discover().then(function (base) {
        if (!base) {
          failures += 1;
          setStatus(failures > 2 ? 'OpenUI not reachable — is the app running?' : 'Looking for OpenUI…', 'err');
          setTimeout(poll, Math.min(POLL_MS * Math.max(1, failures), 5000));
          return;
        }
        BASE = base;
        failures = 0;
        log('connected to ' + BASE);
        poll();
      });
      return;
    }

    fetch(BASE + '/pending?token=' + encodeURIComponent(TOKEN))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        failures = 0;
        if (!data || !data.job) {
          setStatus('Connected — waiting for a build.', 'on');
          setTimeout(poll, POLL_MS);
          return;
        }
        busy = true;
        setStatus('Building "' + (data.job.spec.name || 'design') + '"…', 'on');
        log('build ' + data.job.id + ' started');
        parent.postMessage({ pluginMessage: { type: 'build', job: data.job } }, '*');
      })
      .catch(function () {
        failures += 1;
        // Drop the resolved base so the next tick re-discovers: OpenUI may have
        // restarted onto a different port rather than gone away.
        if (failures > 2) BASE = null;
        setStatus(failures > 3 ? 'OpenUI not reachable — is the app running?' : 'Reconnecting…', 'err');
        setTimeout(poll, Math.min(POLL_MS * Math.max(1, failures), 5000));
      });
  }

  // Results come back from the scene-graph thread; forward them to OpenUI.
  onmessage = function (event) {
    var msg = event.data && event.data.pluginMessage;
    if (!msg || msg.type !== 'result') return;

    log('build ' + msg.jobId + ' ' + (msg.ok ? 'ok — ' + msg.created + ' nodes' : 'FAILED: ' + msg.error));
    fetch(BASE + '/result?token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg)
    }).catch(function () { log('could not report result to OpenUI'); })
      .then(function () { busy = false; setTimeout(poll, POLL_MS); });
  };

  poll();
</script>
`
}

/**
 * code.js — the scene-graph half. Interprets a validated BuildSpec.
 *
 * Two things drive the shape of this code:
 *
 *   1. FONTS MUST BE LOADED FIRST. Figma throws if you assign `.characters`
 *      before the node's font is loaded, and there is no recovering mid-build,
 *      so every font in the spec is loaded up front and a failed load falls
 *      back to Inter rather than aborting.
 *
 *   2. PROPERTY ORDER IS LOAD-BEARING. A node must be appended to its parent
 *      before layout properties mean anything; layoutMode must be set before
 *      resize() or auto-layout overwrites the size; layoutSizingHorizontal
 *      throws unless the parent already has auto-layout. Each assignment is
 *      individually guarded so one unsupported property degrades that property
 *      instead of the whole build.
 */
export function pluginCodeJs(): string {
  return `// OpenUI Builder — generated by OpenUI. Do not edit by hand.
// Interprets a design spec sent from the OpenUI desktop app and builds it
// into the current Figma document.

figma.showUI(__html__, { width: 300, height: 220, title: 'OpenUI Builder' });

var DEFAULT_FAMILY = 'Inter';
var DEFAULT_STYLE = 'Regular';

// ---- helpers ---------------------------------------------------------------

function hexToRgb(hex) {
  var h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: isNaN(a) ? 1 : a
  };
}

// Figma throws eagerly on properties that are invalid for a node's current
// state. Losing one property is acceptable; losing the build is not.
function set(fn) {
  try { fn(); return true; } catch (e) { return false; }
}

function solidPaint(hex) {
  var c = hexToRgb(hex);
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

// ---- font preloading -------------------------------------------------------

function loadFonts(fonts) {
  var wanted = (fonts || []).slice();
  var hasDefault = false;
  for (var i = 0; i < wanted.length; i++) {
    if (wanted[i].family === DEFAULT_FAMILY && wanted[i].style === DEFAULT_STYLE) hasDefault = true;
  }
  // A fresh text node starts as Inter Regular, and mutating it requires that
  // font loaded even when the spec never mentions it.
  if (!hasDefault) wanted.push({ family: DEFAULT_FAMILY, style: DEFAULT_STYLE });

  var loaded = {};
  var jobs = wanted.map(function (f) {
    return figma.loadFontAsync({ family: f.family, style: f.style })
      .then(function () { loaded[f.family + '|' + f.style] = true; })
      .catch(function () { /* missing font — falls back to Inter below */ });
  });
  return Promise.all(jobs).then(function () { return loaded; });
}

// ---- node construction -----------------------------------------------------

function createNode(spec) {
  switch (spec.type) {
    case 'TEXT': return figma.createText();
    case 'RECTANGLE': return figma.createRectangle();
    case 'ELLIPSE': return figma.createEllipse();
    case 'LINE': return figma.createLine();
    default: return figma.createFrame();
  }
}

function applyText(node, spec, loaded) {
  var font = spec.font || {};
  var family = font.family || DEFAULT_FAMILY;
  var style = font.style || DEFAULT_STYLE;
  if (!loaded[family + '|' + style]) { family = DEFAULT_FAMILY; style = DEFAULT_STYLE; }

  set(function () { node.fontName = { family: family, style: style }; });
  set(function () { node.characters = String(spec.text == null ? '' : spec.text); });
  if (font.size != null) set(function () { node.fontSize = font.size; });
  if (font.lineHeight != null) {
    set(function () { node.lineHeight = { value: font.lineHeight, unit: 'PIXELS' }; });
  }
  if (font.letterSpacing != null) {
    set(function () { node.letterSpacing = { value: font.letterSpacing, unit: 'PIXELS' }; });
  }
  if (font.align) set(function () { node.textAlignHorizontal = font.align; });
}

function applyLayout(node, layout) {
  set(function () { node.layoutMode = layout.mode; });
  if (layout.gap != null) set(function () { node.itemSpacing = layout.gap; });
  if (layout.padding) {
    set(function () { node.paddingTop = layout.padding[0]; });
    set(function () { node.paddingRight = layout.padding[1]; });
    set(function () { node.paddingBottom = layout.padding[2]; });
    set(function () { node.paddingLeft = layout.padding[3]; });
  }
  if (layout.primaryAxis) set(function () { node.primaryAxisAlignItems = layout.primaryAxis; });
  if (layout.counterAxis) set(function () { node.counterAxisAlignItems = layout.counterAxis; });
  if (layout.wrap) {
    // Only horizontal auto-layout can wrap; the guard in set() absorbs the
    // throw when a spec asks for a wrapping column.
    set(function () { node.layoutWrap = 'WRAP'; });
    if (layout.rowGap != null) set(function () { node.counterAxisSpacing = layout.rowGap; });
  }
}

function applyCommon(node, spec) {
  if (spec.name) set(function () { node.name = spec.name; });
  if (spec.fill) set(function () { node.fills = [solidPaint(spec.fill)]; });
  if (spec.stroke) {
    set(function () { node.strokes = [solidPaint(spec.stroke.color)]; });
    if (spec.stroke.weight != null) set(function () { node.strokeWeight = spec.stroke.weight; });
  }
  if (spec.radius != null) set(function () { node.cornerRadius = spec.radius; });
  if (spec.opacity != null) set(function () { node.opacity = spec.opacity; });
  if (spec.shadows && spec.shadows.length) {
    set(function () {
      node.effects = spec.shadows.map(function (s) {
        var c = hexToRgb(s.color || '#00000040');
        return {
          type: s.inner ? 'INNER_SHADOW' : 'DROP_SHADOW',
          color: { r: c.r, g: c.g, b: c.b, a: c.a },
          offset: { x: s.x || 0, y: s.y || 0 },
          radius: s.blur || 0,
          spread: s.spread || 0,
          visible: true,
          blendMode: 'NORMAL'
        };
      });
    });
  }
}

var created = 0;

function build(spec, parent, loaded) {
  var node = createNode(spec);
  created += 1;

  // Parent first: layout and sizing properties are meaningless — and some
  // throw — while a node is still detached.
  parent.appendChild(node);

  applyCommon(node, spec);

  // Auto-layout before resize, or auto-layout immediately overrides the size.
  if (spec.type === 'FRAME' && spec.layout) applyLayout(node, spec.layout);

  if (spec.type === 'TEXT') applyText(node, spec, loaded);

  if (spec.width != null && spec.height != null && node.resize) {
    set(function () { node.resize(Math.max(0.01, spec.width), Math.max(0.01, spec.height)); });
  }

  // Positioning is only meaningful relative to a placed parent.
  if (spec.x != null) set(function () { node.x = spec.x; });
  if (spec.y != null) set(function () { node.y = spec.y; });

  if (spec.positioning === 'ABSOLUTE') set(function () { node.layoutPositioning = 'ABSOLUTE'; });
  if (spec.grow != null) set(function () { node.layoutGrow = spec.grow; });
  if (spec.sizing) {
    if (spec.sizing.horizontal) set(function () { node.layoutSizingHorizontal = spec.sizing.horizontal; });
    if (spec.sizing.vertical) set(function () { node.layoutSizingVertical = spec.sizing.vertical; });
  }

  var children = spec.children || [];
  for (var i = 0; i < children.length; i++) build(children[i], node, loaded);

  return node;
}

function resolvePage(name) {
  if (!name) return figma.currentPage;
  var pages = figma.root.children;
  for (var i = 0; i < pages.length; i++) {
    if (pages[i].name === name) return pages[i];
  }
  var page = figma.createPage();
  page.name = name;
  return page;
}

// ---- job runner ------------------------------------------------------------

function runJob(job) {
  created = 0;
  var spec = job.spec;

  // Guard against building into the wrong document. OpenUI asks Figma to open a
  // specific file and waits before queueing, but on a slow machine the switch
  // can still be in flight — and writing a design into whatever file happened
  // to be open is much worse than refusing.
  //
  // figma.fileKey is not populated for every plugin/context, so an unavailable
  // value means "cannot verify" and the build proceeds. Only a definite
  // mismatch is treated as an error.
  if (job.fileKey && typeof figma.fileKey === 'string' && figma.fileKey !== job.fileKey) {
    return Promise.resolve({
      type: 'result',
      jobId: job.id,
      ok: false,
      created: 0,
      error:
        'wrong file is open — expected ' + job.fileKey + ' but Figma is showing ' + figma.fileKey +
        '. Nothing was built. Open the intended file and run the build again.'
    });
  }

  return loadFonts(job.fonts).then(function (loaded) {
    var page = resolvePage(spec.page);
    figma.currentPage = page;

    var roots = [];
    var frames = spec.frames || [];

    // Lay top-level frames out left to right when the spec gives no coordinates,
    // so a multi-frame build does not stack everything at the origin.
    var cursorX = 0;
    for (var i = 0; i < frames.length; i++) {
      var node = build(frames[i], page, loaded);
      if (frames[i].x == null) set(function () { node.x = cursorX; });
      if (frames[i].y == null) set(function () { node.y = 0; });
      cursorX += (node.width || 0) + 100;
      roots.push(node);
    }

    if (roots.length) {
      figma.currentPage.selection = roots;
      figma.viewport.scrollAndZoomIntoView(roots);
    }

    figma.notify('OpenUI built "' + (spec.name || 'design') + '" — ' + created + ' layers');

    return {
      type: 'result',
      jobId: job.id,
      ok: true,
      created: created,
      page: page.name,
      rootIds: roots.map(function (n) { return n.id; }),
      rootNames: roots.map(function (n) { return n.name; })
    };
  }).catch(function (err) {
    return {
      type: 'result',
      jobId: job.id,
      ok: false,
      created: created,
      error: String((err && err.message) || err)
    };
  });
}

figma.ui.onmessage = function (msg) {
  if (!msg || msg.type !== 'build' || !msg.job) return;
  runJob(msg.job).then(function (result) { figma.ui.postMessage(result); });
};
`
}
