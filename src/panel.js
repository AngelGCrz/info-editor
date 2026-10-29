// Panel del info-editor. Lo inyecta el plugin de Vite solo en dev.
// Habla con HelpPagesLayer del engine (window.__gdpHelpPagesLayer), que adapter.js extiende:
//   layer.rebuild(overrides) vuelve a crear las páginas con nuestro json,
//   layer.showPage(i) cambia de página, y cada objeto creado trae __infoSource
//   (su config), al que aquí le ponemos __path para saber qué nodo del json es.
import { adapterError } from 'virtual:info-editor/adapter';

const API = '/__info-editor/api';
const STATE_INFO = 'GAMESTATE_INFO';
const BASE_LANG = 'eng';
const PANEL_WIDTH = 420;

const params = new URLSearchParams(location.search);
const lang = params.get('lang') || BASE_LANG;

const S = {
    meta: null,
    layer: null,
    models: {},     // key ('game', 'jackpot') -> json editado
    saved: {},      // key -> json guardado (string) para saber si hay cambios
    base: {},       // key -> json del idioma base, para comparar
    keyToId: {},    // key -> id del archivo ('info', 'jackpot')
    undo: [],
    redo: [],
    lastCommit: { key: null, time: 0 },
    pageIndex: -1,
    selection: null,  // path del nodo seleccionado
    hover: null,
    tagged: [],       // [{ obj, path }] objetos arrastrables del render actual
    warnings: [],
    moveMode: storage('moveMode', true),
    open: storage('open', true),
    infoVisible: false,
    savedFiles: new Set(),  // archivos guardados en esta sesión, para el aviso al cerrar
    closed: false,
};

const els = {};

// ---------- utilidades ----------

function storage(key, fallback, value) {
    const name = 'info-editor:' + key;

    try {
        if (value !== undefined) {
            localStorage.setItem(name, JSON.stringify(value));
            return value;
        }

        const stored = localStorage.getItem(name);
        return stored === null ? fallback : JSON.parse(stored);
    } catch {
        return value !== undefined ? value : fallback;
    }
}

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }

        if (key.startsWith('on')) {
            el.addEventListener(key.slice(2), value);
        } else if (key === 'class') {
            el.className = value;
        } else if (key === 'value') {
            el.value = value;
        } else {
            el.setAttribute(key, value === true ? '' : value);
        }
    }

    for (const child of children.flat()) {
        if (child !== null && child !== undefined && child !== false) {
            el.append(child instanceof Node ? child : String(child));
        }
    }

    return el;
}

const getAt = (obj, path) => path.reduce((node, key) => (node == null ? undefined : node[key]), obj);

function setAt(obj, path, value) {
    let node = obj;

    for (let i = 0; i < path.length - 1; i++) {
        if (node[path[i]] == null || typeof node[path[i]] !== 'object') {
            node[path[i]] = typeof path[i + 1] === 'number' ? [] : {};
        }

        node = node[path[i]];
    }

    const last = path[path.length - 1];

    if (value === undefined) {
        Array.isArray(node) ? node.splice(last, 1) : delete node[last];
    } else {
        node[last] = value;
    }
}

const samePath = (a, b) => !!a && !!b && a.length === b.length && a.every((key, i) => key === b[i]);
const startsWith = (path, prefix) => !!path && prefix.every((key, i) => path[i] === key);

function parseOffset(value) {
    const [x, y] = String(value || '0,0').split(',').map((n) => parseFloat(n) || 0);
    return { x, y };
}

const formatOffset = (x, y) => `${Math.round(x)},${Math.round(y)}`;

function annotate(node, path) {
    if (!node || typeof node !== 'object') {
        return;
    }

    Object.defineProperty(node, '__path', { value: path, enumerable: false, configurable: true });

    for (const key of Object.keys(node)) {
        annotate(node[key], [...path, Array.isArray(node) ? Number(key) : key]);
    }
}

async function api(route, init) {
    const res = await fetch(API + route, init);
    const text = await res.text();

    if (!res.ok) {
        let message = text;

        try {
            message = JSON.parse(text).error;
        } catch { /* texto plano */ }

        throw new Error(message || res.statusText);
    }

    return text;
}

function rgbToHex(color) {
    const value = String(color || '').trim();

    if (/^#[0-9a-f]{6}$/i.test(value)) {
        return value;
    }

    const match = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);

    if (!match) {
        return '#ffffff';
    }

    return '#' + match.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

function hexToSameFormat(hex, previous) {
    if (previous && /^#/.test(previous)) {
        return hex;
    }

    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgb(${r},${g},${b})`;
}

// ---------- estado / historial ----------

const snapshot = () => JSON.stringify(S.models);
const isDirtyKey = (key) => JSON.stringify(S.models[key]) !== S.saved[key];
const isDirty = () => Object.keys(S.models).some(isDirtyKey);

function commit(key, mutate, { render = false } = {}) {
    const now = Date.now();

    if (S.lastCommit.key !== key || now - S.lastCommit.time > 1200) {
        S.undo.push(snapshot());

        if (S.undo.length > 200) {
            S.undo.shift();
        }

        S.redo = [];
    }

    S.lastCommit = { key, time: now };
    mutate();
    updateHeader();
    schedulePreview();

    if (render) {
        renderPanel();
    }
}

function restore(snap) {
    S.models = JSON.parse(snap);
    S.lastCommit = { key: null, time: 0 };
    preview();
    renderPanel();
    updateHeader();
}

function undo() {
    if (S.undo.length) {
        S.redo.push(snapshot());
        restore(S.undo.pop());
    }
}

function redo() {
    if (S.redo.length) {
        S.undo.push(snapshot());
        restore(S.redo.pop());
    }
}

// ---------- archivos ----------

async function loadKey(key) {
    const id = S.keyToId[key];
    const text = await api(`/file?lang=${lang}&file=${id}`);
    S.models[key] = JSON.parse(text);
    S.saved[key] = JSON.stringify(S.models[key]);
}

async function loadAll() {
    S.models = {};
    S.saved = {};

    for (const [id, file] of Object.entries(S.meta.files)) {
        S.keyToId[file.key] = id;

        if ((S.meta.available[lang] || []).includes(id)) {
            await loadKey(file.key);
        }

        if (lang !== BASE_LANG && (S.meta.available[BASE_LANG] || []).includes(id)) {
            S.base[file.key] = JSON.parse(await api(`/file?lang=${BASE_LANG}&file=${id}`));
        }
    }
}

async function save() {
    const dirty = Object.keys(S.models).filter(isDirtyKey);

    if (!dirty.length) {
        setStatus('Sin cambios por guardar');
        return true;
    }

    let ok = true;

    try {
        const saved = [];

        for (const key of dirty) {
            const text = JSON.stringify(S.models[key]);
            const result = JSON.parse(await api(`/file?lang=${lang}&file=${S.keyToId[key]}`, { method: 'PUT', body: text }));
            S.saved[key] = text;
            S.savedFiles.add(result.path);
            saved.push(result.path + (result.minimal ? '' : ' (reformateado completo)'));
        }

        const fullRewrite = saved.some((each) => each.endsWith('(reformateado completo)'));
        setStatus('Guardado: ' + saved.join(', '), fullRewrite ? 'warn' : 'ok');
    } catch (error) {
        setStatus('Error al guardar: ' + error.message, 'error');
        ok = false;
    }

    updateHeader();
    return ok;
}

// Guarda si hace falta, apaga el servidor del CLI y deja un aviso en la pestaña.
async function closeEditor() {
    if (isDirty()) {
        if (confirm('Hay cambios sin guardar. ¿Guardarlos antes de cerrar?\n\nAceptar = guardar y cerrar\nCancelar = otras opciones')) {
            if (!(await save())) {
                return;
            }
        } else if (!confirm('¿Cerrar el editor SIN guardar los cambios?')) {
            return;
        }
    }

    S.closed = true;

    try {
        await api('/shutdown', { method: 'POST' });
    } catch (error) {
        S.closed = false;
        setStatus('No se pudo cerrar el editor: ' + error.message, 'error');
        return;
    }

    const files = [...S.savedFiles];

    document.body.append(h('div', { class: 'ie-closed' },
        h('div', { class: 'ie-closed-box' },
            h('strong', {}, 'Info editor cerrado'),
            files.length
                ? h('p', {}, 'Guardaste cambios en:', h('br'), ...files.map((file) => h('code', {}, file)))
                : h('p', {}, 'No se guardaron cambios.'),
            h('p', { class: 'ie-muted' }, 'El servidor del juego se apagó. Ya puedes cerrar esta pestaña.'),
        ),
    ));

    window.close();
}

async function reloadFromDisk() {
    if (isDirty() && !confirm('Hay cambios sin guardar. ¿Descartarlos y recargar desde disco?')) {
        return;
    }

    await loadAll();
    S.undo = [];
    S.redo = [];
    preview();
    renderPanel();
    updateHeader();
    setStatus('Recargado desde disco');
}

// ---------- render en pixi ----------

let previewTimer = 0;

function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 120);
}

function preview() {
    clearTimeout(previewTimer);

    if (!S.layer) {
        return;
    }

    const overrides = {};

    for (const key of Object.keys(S.models)) {
        const clone = structuredClone(S.models[key]);
        annotate(clone, [key]);
        overrides[key] = clone;
    }

    try {
        S.layer.rebuild(overrides);
    } catch (error) {
        console.error('[info-editor]', error);
        setStatus('Error al renderizar: ' + error.message, 'error');
        return;
    }

    bindInteractions();
    computeWarnings();
    renderWarnings();
}

function bindInteractions() {
    const pages = new Set(S.layer.pages);
    S.tagged = [];

    const walk = (container) => {
        for (const child of container.children || []) {
            const path = child.__infoSource && child.__infoSource.__path;

            if (path && !pages.has(child)) {
                S.tagged.push({ obj: child, path });
                makeDraggable(child, path);
            }

            walk(child);
        }
    };

    walk(S.layer.canvas);
}

// Dónde se escribe el offset al mover un nodo y desde qué valor se parte.
function offsetTarget(path) {
    const node = getAt(S.models, path) || {};

    if (Array.isArray(node.lines)) {
        return {
            path: [...path, 'setting', 'offset'],
            base: (node.setting && node.setting.offset) || getAt(S.models, [path[0], 'rules', 'settings', 'items', 'offset']) || '0,0',
        };
    }

    const inheritsRules = path.includes('rules') && path.includes('titles');

    return {
        path: [...path, 'offset'],
        base: node.offset || (inheritsRules && getAt(S.models, [path[0], 'rules', 'settings', 'titles', 'offset'])) || '0,0',
    };
}

function moveNode(path, dx, dy, key) {
    const target = offsetTarget(path);
    const base = parseOffset(target.base);
    commit(key || 'move:' + path.join('.'), () => setAt(S.models, target.path, formatOffset(base.x + dx, base.y + dy)), { render: true });
}

function makeDraggable(obj, path) {
    obj.eventMode = 'static';
    obj.cursor = S.moveMode ? 'move' : 'pointer';

    obj.on('pointerover', () => { S.hover = path; });
    obj.on('pointerout', () => { if (samePath(S.hover, path)) S.hover = null; });
    obj.on('pointerdown', (event) => {
        event.stopPropagation();
        select(path);

        if (!S.moveMode) {
            return;
        }

        const parent = obj.parent;
        const start = parent.toLocal(event.global);
        const startPos = { x: obj.position.x, y: obj.position.y };
        const base = parseOffset(offsetTarget(path).base);
        let delta = { x: 0, y: 0 };

        const onMove = (moveEvent) => {
            const point = parent.toLocal(moveEvent.global);
            delta = { x: point.x - start.x, y: point.y - start.y };
            obj.position.set(startPos.x + delta.x, startPos.y + delta.y);
            setStatus(`offset: ${formatOffset(base.x + delta.x, base.y - delta.y)}`);
        };

        const onUp = () => {
            obj.off('globalpointermove', onMove);
            window.removeEventListener('pointerup', onUp, true);

            if (Math.abs(delta.x) >= 0.5 || Math.abs(delta.y) >= 0.5) {
                // En pixi la Y crece hacia abajo; en el json hacia arriba.
                moveNode(path, delta.x, -delta.y, 'drag:' + Date.now());
            }
        };

        obj.on('globalpointermove', onMove);
        window.addEventListener('pointerup', onUp, true);
    });
}

function isShown(obj) {
    for (let node = obj; node; node = node.parent) {
        if (!node.visible) {
            return false;
        }
    }

    return true;
}

function currentPage() {
    const page = S.layer && S.layer.pages[S.pageIndex];

    if (!page) {
        return null;
    }

    return { page, path: page.__infoSource && page.__infoSource.__path, type: page.config && page.config.type };
}

function computeWarnings() {
    S.warnings = [];
    const current = currentPage();

    if (!current || !current.path) {
        return;
    }

    const background = S.layer.backgrounds[current.type];

    if (!background) {
        return;
    }

    const area = background.getBounds();
    const margin = 2;
    const outside = (b) => b.x < area.x - margin || b.y < area.y - margin
        || b.x + b.width > area.x + area.width + margin || b.y + b.height > area.y + area.height + margin;

    for (const { obj, path } of S.tagged) {
        if (!startsWith(path, current.path)) {
            continue;
        }

        const node = getAt(S.models, path) || {};

        if (Array.isArray(node.lines)) {
            obj.children.forEach((row, i) => {
                if (outside(row.getBounds())) {
                    const text = row.children.map((part) => part.text || '◆').join('');
                    S.warnings.push({ path, label: `Renglón ${i + 1} se sale: "${text.trim().slice(0, 40)}"` });
                }
            });
        } else if (outside(obj.getBounds())) {
            S.warnings.push({ path, label: `Se sale de la página: ${node.text || node.path || node.src || path.join('.')}` });
        }
    }
}

// ---------- overlay de selección ----------

function screenRatio() {
    const canvas = document.getElementById('gameCanvas');

    if (!canvas) {
        return null;
    }

    const rect = canvas.getBoundingClientRect();
    const screenWidth = parseFloat(canvas.style.width) || rect.width;

    return { rect, ratio: rect.width / screenWidth };
}

function drawOverlay() {
    const view = screenRatio();
    const boxes = [];

    if (view && S.layer && S.layer.visible) {
        const current = currentPage();
        const warned = new Set(S.warnings.map((w) => w.path.join('.')));

        for (const { obj, path } of S.tagged) {
            if (!isShown(obj) || !current || !startsWith(path, current.path || [])) {
                continue;
            }

            const selected = samePath(path, S.selection);
            const hovered = samePath(path, S.hover);
            const warn = warned.has(path.join('.'));

            if (!selected && !hovered && !warn && !S.moveMode) {
                continue;
            }

            const b = obj.getBounds();
            boxes.push({
                x: view.rect.left + b.x * view.ratio,
                y: view.rect.top + b.y * view.ratio,
                w: b.width * view.ratio,
                h: b.height * view.ratio,
                cls: selected ? 'sel' : warn ? 'warn' : hovered ? 'hover' : 'faint',
            });
        }
    }

    while (els.overlay.children.length < boxes.length) {
        els.overlay.append(h('div'));
    }

    [...els.overlay.children].forEach((box, i) => {
        const data = boxes[i];
        box.style.display = data ? 'block' : 'none';

        if (data) {
            box.className = 'ie-box ie-box-' + data.cls;
            box.style.transform = `translate(${data.x}px, ${data.y}px)`;
            box.style.width = data.w + 'px';
            box.style.height = data.h + 'px';
        }
    });
}

function tick() {
    if (S.layer) {
        if (S.layer.pageId !== S.pageIndex) {
            S.pageIndex = S.layer.pageId;
            const current = currentPage();

            if (!current || !startsWith(S.selection, current.path || ['-'])) {
                S.selection = null;
            }

            computeWarnings();
            renderPanel();
        }

        if (S.layer.visible !== S.infoVisible) {
            S.infoVisible = S.layer.visible;
            updateHeader();
        }
    }

    drawOverlay();
    requestAnimationFrame(tick);
}

// ---------- panel ----------

function setStatus(text, kind = '') {
    els.status.textContent = text;
    els.status.className = 'ie-status ' + kind;
}

function select(path) {
    S.selection = path;
    renderPanel();
    const card = els.body.querySelector(`[data-path="${CSS.escape(path.join('.'))}"]`);

    if (card) {
        card.scrollIntoView({ block: 'nearest' });
    }
}

function goToPage(index) {
    if (!S.layer) {
        return;
    }

    S.layer.showPage(index);
}

function openInfo() {
    if (S.layer && !S.layer.visible) {
        S.layer.data.changeState(STATE_INFO);
    }
}

function setOpen(open) {
    S.open = storage('open', true, open);
    document.documentElement.classList.toggle('ie-open', open);
}

function setMoveMode(on) {
    S.moveMode = storage('moveMode', true, on);
    S.tagged.forEach(({ obj }) => { obj.cursor = on ? 'move' : 'pointer'; });
    updateHeader();
}

function changeLang(value) {
    if (isDirty() && !confirm('Hay cambios sin guardar. ¿Cambiar de idioma y perderlos?')) {
        els.lang.value = lang;
        return;
    }

    params.set('lang', value);
    location.search = params.toString();
}

function updateHeader() {
    if (!els.save) {
        return;
    }

    const dirty = isDirty();
    els.save.disabled = !dirty;
    els.save.textContent = dirty ? 'Guardar •' : 'Guardado';
    els.undo.disabled = !S.undo.length;
    els.redo.disabled = !S.redo.length;
    els.move.classList.toggle('on', S.moveMode);
    els.info.disabled = !S.layer || S.infoVisible;
    document.title = (dirty ? '● ' : '') + document.title.replace(/^● /, '');
}

function buildShell() {
    els.overlay = h('div', { class: 'ie-overlay' });
    els.status = h('div', { class: 'ie-status' }, 'Cargando…');
    els.body = h('div', { class: 'ie-body' });
    els.lang = h('select', { class: 'ie-lang', title: 'Idioma (recarga el juego)', onchange: (e) => changeLang(e.target.value) });
    els.save = h('button', { class: 'ie-primary', title: 'Guardar (⌘S)', onclick: save }, 'Guardado');
    els.undo = h('button', { title: 'Deshacer (⌘Z)', onclick: undo }, '↶');
    els.redo = h('button', { title: 'Rehacer (⇧⌘Z)', onclick: redo }, '↷');
    els.move = h('button', { title: 'Arrastrar textos e imágenes en el juego', onclick: () => setMoveMode(!S.moveMode) }, '✥ Mover');
    els.info = h('button', { title: 'Entrar al estado de info del juego', onclick: openInfo }, 'Abrir info');

    els.panel = h('aside', { class: 'ie-panel' },
        h('header', { class: 'ie-header' },
            h('div', { class: 'ie-row' },
                h('strong', { class: 'ie-title' }, 'Info editor'),
                els.lang,
                h('span', { class: 'ie-grow' }),
                h('button', { class: 'ie-danger', title: 'Guardar si hace falta y apagar el editor', onclick: closeEditor }, '⏻ Cerrar editor'),
                h('button', { title: 'Ocultar panel', onclick: () => setOpen(false) }, '⟩'),
            ),
            h('div', { class: 'ie-row' },
                els.info, els.move, els.undo, els.redo,
                h('button', { title: 'Recargar desde disco', onclick: reloadFromDisk }, '⟳'),
                h('span', { class: 'ie-grow' }),
                els.save,
            ),
            els.status,
        ),
        els.body,
    );

    els.tab = h('button', { class: 'ie-tab', onclick: () => setOpen(true), title: 'Abrir info editor' }, '✎ Info');

    document.body.append(els.overlay, els.panel, els.tab);
    setOpen(S.open);
}

function renderPanel() {
    if (!els.body) {
        return;
    }

    const scroll = els.body.scrollTop;
    els.body.replaceChildren();

    if (!S.layer) {
        els.body.append(h('p', { class: 'ie-muted' }, 'Esperando a que el juego cree el info…'));
        return;
    }

    els.body.append(renderPageList());
    const current = currentPage();

    if (!current) {
        return;
    }

    if (!current.path) {
        els.body.append(h('p', { class: 'ie-muted' }, 'Esta página viene de common y no es parte del info del juego.'));
        return;
    }

    els.warnings = h('div', { class: 'ie-warnings' });
    els.body.append(els.warnings);
    renderWarnings();

    const node = getAt(S.models, current.path) || {};
    const pagePath = current.path;

    (node.titles || []).forEach((_, i) => els.body.append(titleCard([...pagePath, 'titles', i])));

    if (node.items && Array.isArray(node.items.lines)) {
        els.body.append(itemsCard([...pagePath, 'items']));
    }

    (node.images || []).forEach((_, i) => els.body.append(imageCard([...pagePath, 'images', i])));

    if (pagePath.includes('rules')) {
        els.body.append(rulesSettingsCard([pagePath[0], 'rules', 'settings']));
    }

    els.body.append(rawCard(pagePath));
    els.body.scrollTop = scroll;
}

function renderWarnings() {
    if (!els.warnings) {
        return;
    }

    els.warnings.replaceChildren(...S.warnings.map((w) => h('button', {
        class: 'ie-warning',
        onclick: () => select(w.path),
    }, '⚠ ' + w.label)));
}

function pageLabel(page, i) {
    const path = page.__infoSource && page.__infoSource.__path;
    const type = page.config && page.config.type;

    if (!path) {
        return `${i + 1}. ${type} (common)`;
    }

    const node = getAt(S.models, path) || {};
    const title = node.titles && node.titles[0] && node.titles[0].text;
    const kinds = { payTables: 'Pagos', payLines: 'Líneas', rules: path[0] === 'jackpot' ? 'Jackpot' : 'Reglas' };

    return `${i + 1}. ${kinds[path[1]] || path[1]}${title ? ' · ' + title : ''}`;
}

function renderPageList() {
    const pages = S.layer.pages;
    const selectEl = h('select', { class: 'ie-grow', onchange: (e) => goToPage(Number(e.target.value)) },
        pages.map((page, i) => h('option', { value: i, selected: i === S.pageIndex }, pageLabel(page, i))));

    return h('div', { class: 'ie-pages' },
        h('button', { title: 'Página anterior', onclick: () => goToPage((S.layer.pageId - 1 + pages.length) % pages.length) }, '‹'),
        selectEl,
        h('button', { title: 'Página siguiente', onclick: () => goToPage((S.layer.pageId + 1) % pages.length) }, '›'),
    );
}

function card(path, title, ...children) {
    const selected = samePath(path, S.selection);

    return h('section', {
        class: 'ie-card' + (selected ? ' sel' : ''),
        'data-path': path.join('.'),
        onclick: (e) => {
            if (!samePath(S.selection, path) && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName)) {
                select(path);
            }
        },
    },
    h('div', { class: 'ie-card-title' }, title),
    ...children);
}

function baseHint(path) {
    if (lang === BASE_LANG) {
        return null;
    }

    const value = getAt(S.base, path);

    if (value === undefined) {
        return null;
    }

    return h('div', { class: 'ie-hint', title: 'Texto en ' + BASE_LANG }, `${BASE_LANG}: ${Array.isArray(value) ? value.join(' ⏎ ') : value}`);
}

// Campo genérico. Vacío = se borra la key y hereda el valor por defecto.
function field(label, path, opts = {}) {
    const value = getAt(S.models, path);
    const type = opts.type || 'text';
    const key = 'field:' + path.join('.');
    let input;

    const write = (raw) => {
        let next = raw;

        if (type === 'number') {
            next = raw === '' ? undefined : Number(raw);

            if (Number.isNaN(next)) {
                return;
            }
        } else if (raw === '' && !opts.keepEmpty) {
            next = undefined;
        }

        commit(key, () => setAt(S.models, path, next));
    };

    if (type === 'textarea') {
        input = h('textarea', { rows: opts.rows || 2, placeholder: opts.placeholder, value: value ?? '' });
    } else if (type === 'select') {
        input = h('select', {}, opts.options.map(([v, text]) => h('option', { value: v, selected: (value ?? '') === v }, text)));
    } else {
        input = h('input', { type: type === 'number' ? 'number' : 'text', step: opts.step, placeholder: opts.placeholder, value: value ?? '' });
    }

    input.addEventListener(type === 'select' ? 'change' : 'input', () => write(input.value));

    const children = [input];

    if (type === 'color') {
        const picker = h('input', { type: 'color', value: rgbToHex(value || opts.placeholder) });
        picker.addEventListener('input', () => {
            input.value = hexToSameFormat(picker.value, getAt(S.models, path));
            write(input.value);
        });
        input.addEventListener('input', () => { picker.value = rgbToHex(input.value || opts.placeholder); });
        children.unshift(picker);
    }

    return h('label', { class: 'ie-field' + (opts.wide ? ' ie-wide' : '') + (type === 'color' ? ' ie-color' : '') },
        h('span', {}, label), h('div', { class: 'ie-input' }, children));
}

function offsetField(label, path, placeholder) {
    const current = getAt(S.models, path);
    const point = current === undefined ? null : parseOffset(current);
    const fallback = parseOffset(placeholder);
    const x = h('input', { type: 'number', value: point ? point.x : '', placeholder: placeholder ? fallback.x : 'x' });
    const y = h('input', { type: 'number', value: point ? point.y : '', placeholder: placeholder ? fallback.y : 'y' });

    // Se escribe lo que está en los campos, sin redondear: editar X no debe tocar Y.
    const write = () => {
        const next = x.value === '' && y.value === '' ? undefined : `${x.value === '' ? fallback.x : x.value},${y.value === '' ? fallback.y : y.value}`;
        commit('field:' + path.join('.'), () => setAt(S.models, path, next));
    };

    x.addEventListener('input', write);
    y.addEventListener('input', write);

    return h('label', { class: 'ie-field' }, h('span', {}, label), h('div', { class: 'ie-input ie-xy' }, x, y));
}

function titleCard(path) {
    const node = getAt(S.models, path) || {};
    const inherited = path.includes('rules') ? (getAt(S.models, [path[0], 'rules', 'settings', 'titles']) || {}) : {};
    const font = inherited.font || {};

    return card(path, `Título ${path[path.length - 1] + 1}${node.tag ? ' · ' + node.tag : ''}`,
        field('Texto', [...path, 'text'], { type: 'textarea', wide: true, keepEmpty: true }),
        baseHint([...path, 'text']),
        h('div', { class: 'ie-grid' },
            field('Tamaño', [...path, 'size'], { type: 'number', placeholder: font.size }),
            field('Escala', [...path, 'scale'], { type: 'number', step: 0.05, placeholder: 1 }),
            field('Alinear', [...path, 'align'], { type: 'select', options: [['', '(centro)'], ['left', 'izquierda'], ['center', 'centro'], ['right', 'derecha']] }),
            offsetField('Offset x,y', [...path, 'offset'], inherited.offset),
            field('Color', [...path, 'color'], { type: 'color', placeholder: font.color }),
            field('Borde', [...path, 'stroke', 'size'], { type: 'number', placeholder: font.stroke && font.stroke.size }),
            field('Color borde', [...path, 'stroke', 'color'], { type: 'color', placeholder: font.stroke && font.stroke.color }),
        ),
    );
}

function imageCard(path) {
    const node = getAt(S.models, path) || {};

    return card(path, `Imagen · ${node.path || node.src || path[path.length - 1]}`,
        h('div', { class: 'ie-grid' },
            offsetField('Offset x,y', [...path, 'offset']),
            field('Escala', [...path, 'scale'], { type: 'number', step: 0.05, placeholder: 1 }),
        ),
    );
}

function symbolNames(rulesRoot) {
    const symbols = getAt(S.models, [rulesRoot, 'rules', 'settings', 'items', 'symbols']) || {};
    const names = new Set(Object.keys(symbols).filter((name) => name !== 'default'));
    const text = JSON.stringify(S.models[rulesRoot] || {});

    for (const match of text.matchAll(/##([^#]+?)##/g)) {
        names.add(match[1].split('.')[0]);
    }

    return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function itemsCard(path) {
    const linesPath = [...path, 'lines'];
    const lines = getAt(S.models, linesPath) || [];
    const settings = getAt(S.models, [path[0], 'rules', 'settings', 'items']) || {};
    const textarea = h('textarea', { class: 'ie-lines', rows: Math.max(4, lines.length + 1), value: lines.join('\n'), spellcheck: false });

    textarea.addEventListener('input', () => {
        textarea.rows = Math.max(4, textarea.value.split('\n').length + 1);
        commit('lines:' + linesPath.join('.'), () => setAt(S.models, linesPath, textarea.value.split('\n')));
    });

    const insert = h('select', {
        onchange: (e) => {
            if (!e.target.value) {
                return;
            }

            const token = `##${e.target.value}.png##`;
            const { selectionStart: start, selectionEnd: end } = textarea;
            textarea.setRangeText(token, start, end, 'end');
            textarea.dispatchEvent(new Event('input'));
            textarea.focus();
            e.target.value = '';
        },
    }, h('option', { value: '' }, '+ símbolo'), symbolNames(path[0]).map((name) => h('option', { value: name }, name)));

    return card(path, 'Renglones (cada línea = un elemento de lines)',
        textarea,
        h('div', { class: 'ie-row' }, insert, h('span', { class: 'ie-muted' }, 'Línea vacía = espacio. ##sym_X.png## = símbolo.')),
        lang !== BASE_LANG && getAt(S.base, linesPath)
            ? h('details', { class: 'ie-hint' }, h('summary', {}, `Ver en ${BASE_LANG}`), h('pre', {}, getAt(S.base, linesPath).join('\n')))
            : null,
        h('div', { class: 'ie-subtitle' }, 'Solo esta página (vacío = usa ajustes de reglas)'),
        h('div', { class: 'ie-grid' },
            field('Tamaño', [...path, 'setting', 'font', 'size'], { type: 'number', placeholder: settings.font && settings.font.size }),
            field('Interlineado', [...path, 'setting', 'gap'], { type: 'number', placeholder: settings.gap }),
            offsetField('Offset x,y', [...path, 'setting', 'offset'], settings.offset),
        ),
    );
}

function rulesSettingsCard(path) {
    const symbolsPath = [...path, 'items', 'symbols'];
    const symbols = getAt(S.models, symbolsPath) || {};
    const newName = h('input', { type: 'text', placeholder: 'sym_10' });

    const rows = Object.keys(symbols).map((name) => h('div', { class: 'ie-symbol' },
        h('code', {}, name),
        field('Escala', [...symbolsPath, name, 'scale'], { type: 'number', step: 0.05 }),
        field('gapX', [...symbolsPath, name, 'gapX'], { type: 'number', step: 1 }),
        field('gapY', [...symbolsPath, name, 'gapY'], { type: 'number', step: 0.05 }),
        h('button', {
            title: 'Quitar',
            onclick: () => commit('symbol-remove', () => setAt(S.models, [...symbolsPath, name], undefined), { render: true }),
        }, '×'),
    ));

    return h('details', { class: 'ie-card', open: storage('settingsOpen', false) || undefined, ontoggle: (e) => storage('settingsOpen', false, e.target.open) },
        h('summary', { class: 'ie-card-title' }, 'Ajustes de reglas (todas las páginas)'),
        h('div', { class: 'ie-subtitle' }, 'Títulos'),
        h('div', { class: 'ie-grid' },
            field('Tamaño', [...path, 'titles', 'font', 'size'], { type: 'number' }),
            field('Color', [...path, 'titles', 'font', 'color'], { type: 'color' }),
            offsetField('Offset x,y', [...path, 'titles', 'offset']),
        ),
        h('div', { class: 'ie-subtitle' }, 'Renglones'),
        h('div', { class: 'ie-grid' },
            field('Tamaño', [...path, 'items', 'font', 'size'], { type: 'number' }),
            field('Color', [...path, 'items', 'font', 'color'], { type: 'color' }),
            field('Interlineado', [...path, 'items', 'gap'], { type: 'number' }),
            offsetField('Offset x,y', [...path, 'items', 'offset']),
        ),
        h('div', { class: 'ie-subtitle' }, 'Tamaño de símbolos en el texto'),
        rows,
        h('div', { class: 'ie-row' },
            newName,
            h('button', {
                onclick: () => {
                    const name = newName.value.trim().replace(/\.png$/, '');

                    if (name && !symbols[name]) {
                        commit('symbol-add', () => setAt(S.models, [...symbolsPath, name], { scale: 0.35, gapX: 0 }), { render: true });
                    }
                },
            }, '+ Agregar símbolo'),
        ),
    );
}

function rawCard(path) {
    const textarea = h('textarea', { class: 'ie-raw', rows: 12, spellcheck: false, value: JSON.stringify(getAt(S.models, path), null, 2) });
    const error = h('div', { class: 'ie-muted' });

    const apply = () => {
        try {
            const value = JSON.parse(textarea.value);
            commit('raw:' + Date.now(), () => setAt(S.models, path, value), { render: true });
        } catch (e) {
            error.textContent = 'JSON inválido: ' + e.message;
        }
    };

    return h('details', { class: 'ie-card' },
        h('summary', { class: 'ie-card-title' }, 'JSON de la página (avanzado)'),
        textarea,
        h('div', { class: 'ie-row' }, h('button', { onclick: apply }, 'Aplicar'), error),
    );
}

// ---------- teclado ----------

function onKeyDown(event) {
    const mod = event.metaKey || event.ctrlKey;
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);

    if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
    } else if (mod && event.key.toLowerCase() === 'z' && !editing) {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
    } else if (!editing && S.selection && event.key.startsWith('Arrow')) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        moveNode(S.selection, ...moves[event.key], 'nudge:' + S.selection.join('.'));
    } else if (!editing && event.key === 'Escape') {
        S.selection = null;
        renderPanel();
    }
}

// ---------- inicio ----------

function attachLayer(layer, deferred = false) {
    if (S.layer) {
        return;
    }

    // Nunca reconstruir dentro del initialize() del engine que nos avisó.
    if (!deferred) {
        setTimeout(() => attachLayer(layer, true), 0);
        return;
    }

    S.layer = layer;
    S.pageIndex = layer.pageId;
    preview();
    renderPanel();
    updateHeader();
    setStatus(`${S.meta.game} · ${lang}`);
}

async function init() {
    injectStyles();
    buildShell();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('beforeunload', (event) => {
        if (isDirty() && !S.closed) {
            event.preventDefault();
        }
    });
    requestAnimationFrame(tick);

    if (adapterError) {
        setStatus(adapterError, 'error');
        return;
    }

    try {
        S.meta = JSON.parse(await api('/meta'));
        await loadAll();
    } catch (error) {
        setStatus('No se pudieron leer los json: ' + error.message, 'error');
        return;
    }

    els.lang.replaceChildren(...S.meta.langs.map((each) => h('option', { value: each, selected: each === lang }, each)));

    if (!Object.keys(S.models).length) {
        setStatus(`No hay archivos de info para "${lang}"`, 'error');
        return;
    }

    setStatus('Esperando al juego…');
    renderPanel();

    if (window.__gdpHelpPagesLayer) {
        attachLayer(window.__gdpHelpPagesLayer);
    } else {
        window.addEventListener('gdp:helppages-ready', (e) => attachLayer(e.detail));
    }

    if (import.meta.hot) {
        import.meta.hot.on('info-editor:changed', async ({ lang: changedLang, file }) => {
            const key = S.meta.files[file] && S.meta.files[file].key;

            if (changedLang !== lang || !key) {
                return;
            }

            if (isDirtyKey(key)) {
                setStatus(`${file} cambió en disco, pero tienes cambios sin guardar`, 'warn');
                return;
            }

            await loadKey(key);
            preview();
            renderPanel();
            updateHeader();
            setStatus(`${file} recargado (cambió en disco)`);
        });
    }
}

function injectStyles() {
    const css = `
    html.ie-open #gameCanvas { width: calc(100vw - ${PANEL_WIDTH}px) !important; height: auto !important; }
    .ie-panel, .ie-tab { font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #e6e6e6; }
    .ie-panel { position: fixed; top: 0; right: 0; bottom: 0; width: ${PANEL_WIDTH}px; z-index: 100000; display: none;
        flex-direction: column; background: #1b1d22; border-left: 1px solid #333; box-sizing: border-box; }
    html.ie-open .ie-panel { display: flex; }
    html.ie-open .ie-tab { display: none; }
    .ie-tab { position: fixed; top: 8px; right: 8px; z-index: 100000; }
    .ie-panel .ie-danger:hover { background: #5a2626; border-color: #8a3a3a; }
    .ie-closed { position: fixed; inset: 0; z-index: 100001; background: rgba(10,11,14,.92); display: flex;
        align-items: center; justify-content: center; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #e6e6e6; }
    .ie-closed-box { background: #1b1d22; border: 1px solid #333; border-radius: 8px; padding: 24px 28px; max-width: 460px; }
    .ie-closed-box strong { font-size: 18px; }
    .ie-closed-box code { display: block; color: #6fd39a; margin-top: 4px; }
    .ie-panel *, .ie-tab { box-sizing: border-box; }
    .ie-header { padding: 8px; border-bottom: 1px solid #333; display: flex; flex-direction: column; gap: 6px; }
    .ie-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .ie-grow { flex: 1; }
    .ie-title { font-size: 13px; }
    .ie-panel button, .ie-tab { background: #2b2f37; color: inherit; border: 1px solid #3c414b; border-radius: 4px;
        padding: 4px 8px; cursor: pointer; font: inherit; }
    .ie-panel button:hover:not(:disabled), .ie-tab:hover { background: #363b45; }
    .ie-panel button:disabled { opacity: .45; cursor: default; }
    .ie-panel button.on { background: #2f5d9a; border-color: #3f78c4; }
    .ie-panel .ie-primary:not(:disabled) { background: #2f7d4f; border-color: #3c9a62; }
    .ie-panel input, .ie-panel select, .ie-panel textarea { background: #111317; color: inherit; border: 1px solid #3c414b;
        border-radius: 4px; padding: 4px 6px; font: inherit; min-width: 0; }
    .ie-panel textarea { width: 100%; resize: vertical; }
    .ie-panel input:focus, .ie-panel select:focus, .ie-panel textarea:focus { outline: 1px solid #4a8fe0; border-color: #4a8fe0; }
    .ie-status { color: #9aa0aa; min-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ie-status.ok { color: #6fd39a; } .ie-status.error { color: #ff7b7b; white-space: normal; } .ie-status.warn { color: #f2c46d; }
    .ie-body { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
    .ie-pages { display: flex; gap: 6px; position: sticky; top: -8px; background: #1b1d22; padding: 4px 0; z-index: 1; }
    .ie-card { background: #23262d; border: 1px solid #30343c; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
    .ie-card.sel { border-color: #4a8fe0; box-shadow: 0 0 0 1px #4a8fe0; }
    .ie-card-title { font-weight: 600; color: #cfd3da; cursor: pointer; }
    .ie-subtitle { color: #9aa0aa; margin-top: 4px; }
    .ie-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .ie-field { display: flex; flex-direction: column; gap: 2px; }
    .ie-field > span { color: #9aa0aa; font-size: 11px; }
    .ie-input { display: flex; gap: 4px; }
    .ie-input > input, .ie-input > select, .ie-input > textarea { flex: 1; width: 100%; }
    .ie-color input[type=color] { flex: 0 0 28px; padding: 0; height: 26px; border: none; background: none; }
    .ie-xy input { width: 50%; }
    .ie-hint { color: #8d96a3; font-size: 11px; font-style: italic; overflow-wrap: anywhere; }
    .ie-hint pre { white-space: pre-wrap; font-style: normal; margin: 4px 0 0; }
    .ie-muted { color: #8d96a3; }
    .ie-lines, .ie-raw { font-family: ui-monospace, Menlo, monospace; font-size: 12px; white-space: pre; overflow-x: auto; }
    .ie-symbol { display: grid; grid-template-columns: 70px 1fr 1fr 1fr 26px; gap: 4px; align-items: end; }
    .ie-symbol code { padding-bottom: 6px; }
    .ie-warnings { display: flex; flex-direction: column; gap: 4px; }
    .ie-panel .ie-warning { text-align: left; background: #3a2a12; border-color: #7a5a1c; color: #f2c46d; }
    .ie-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 99999; }
    .ie-box { position: absolute; left: 0; top: 0; border: 1px dashed rgba(120,170,255,.35); }
    .ie-box-hover { border: 1px solid rgba(120,170,255,.9); }
    .ie-box-sel { border: 2px solid #4a8fe0; background: rgba(74,143,224,.08); }
    .ie-box-warn { border: 2px solid #ff9d3c; }
    `;

    document.head.append(h('style', {}, css));
}

init();
