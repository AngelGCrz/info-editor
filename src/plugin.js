// Plugin de Vite del info-editor. Lo agrega el CLI en memoria; el juego no tiene que importarlo.
//  - API local para leer/guardar los json de idioma.
//  - Inyecta el panel y el adaptador del engine en el index.html (solo en dev).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchJson } from './jsonpatch.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const VIRTUAL_PREFIX = 'virtual:info-editor/';
const API_PREFIX = '/__info-editor/api';
const LANG_RE = /^[a-z]{2,3}(-[a-z]+)?$/i;

// id -> ruta dentro de {languagesDir}/{lang}/ y la key con la que HelpPagesLayer la usa.
const DEFAULT_FILES = {
    info: { path: 'info/info.json', key: 'game', loaderKey: 'game_helppage_json' },
    jackpot: { path: 'info/jackpotpages.json', key: 'jackpot', loaderKey: 'jackpot_helppage_json' },
};

// Módulos del engine que el adaptador necesita, relativos a la raíz del juego.
const ENGINE_FILES = {
    GDP: 'engine/system/gdp.ts',
    GdpBoot: 'engine/system/gdpboot.ts',
    HelpPagesLayer: 'engine/system/layers/helppages/helppageslayer.ts',
};

export function findLanguagesDir(root, publicDir = path.join(root, 'public')) {
    const dir = path.join(publicDir, 'assets', 'languages');
    return fs.existsSync(dir) ? dir : null;
}

function engineModule(root) {
    const missing = Object.entries(ENGINE_FILES).filter(([, file]) => !fs.existsSync(path.join(root, file)));

    if (missing.length) {
        return `export const engineError = ${JSON.stringify('No encontré en el juego: ' + missing.map(([, file]) => file).join(', '))};\n`
            + Object.keys(ENGINE_FILES).map((name) => `export const ${name} = null;`).join('\n');
    }

    // Mismas URLs que usa el juego, así Vite comparte la misma instancia de cada módulo.
    // gdp.ts primero: es la misma entrada que usa src/index.ts del juego.
    return [
        `export { GDP } from '/${ENGINE_FILES.GDP}';`,
        `export { GdpBoot } from '/${ENGINE_FILES.GdpBoot}';`,
        `export { default as HelpPagesLayer } from '/${ENGINE_FILES.HelpPagesLayer}';`,
        'export const engineError = null;',
    ].join('\n');
}

/**
 * @param {object} [options]
 * @param {Record<string, {path: string, key: string, loaderKey: string}>} [options.files]
 * @param {() => void} [options.onShutdown] lo llama el botón "Cerrar editor"; el CLI apaga el proceso.
 */
export default function infoEditor(options = {}) {
    const files = options.files || DEFAULT_FILES;
    let viteServer = null;
    // Archivos que escribió el editor, para no avisarle de sus propios cambios.
    const ownWrites = new Map();
    let langRoot = '';
    let root = '';

    const filePath = (lang, id) => path.join(langRoot, lang, files[id].path);

    const listLangs = () => fs.existsSync(langRoot)
        ? fs.readdirSync(langRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory() && LANG_RE.test(d.name))
            .map((d) => d.name)
            .sort()
        : [];

    const fileIdFromPath = (abs) => {
        const rel = path.relative(langRoot, abs).split(path.sep);
        const lang = rel.shift();
        const sub = rel.join('/');
        const id = Object.keys(files).find((each) => files[each].path === sub);

        return id && lang ? { lang, file: id } : null;
    };

    // Solo cambia en el archivo el texto de los valores que cambiaron (ver jsonpatch.js).
    const writeJson = (abs, text) => {
        const data = JSON.parse(text);
        const original = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
        const result = original
            ? patchJson(original, data)
            : { text: JSON.stringify(data, null, 4) + '\n', minimal: true };

        if (result.text !== original) {
            ownWrites.set(abs, Date.now());
            fs.writeFileSync(abs, result.text, 'utf8');
        }

        return result.minimal;
    };

    const readBody = (req) => new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            body += chunk;

            if (body.length > 5 * 1024 * 1024) {
                reject(new Error('body demasiado grande'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });

    const send = (res, status, data) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };

    return {
        name: 'gdp-info-editor',
        apply: 'serve',

        configResolved(config) {
            root = config.root;
            langRoot = path.resolve(config.publicDir || path.join(root, 'public'), 'assets', 'languages');
        },

        resolveId(id) {
            const clean = id.replace(/^\/@id\//, '');
            return clean.startsWith(VIRTUAL_PREFIX) ? '\0' + clean : null;
        },

        load(id) {
            if (!id.startsWith('\0' + VIRTUAL_PREFIX)) {
                return null;
            }

            const name = id.slice(VIRTUAL_PREFIX.length + 1);

            if (name === 'engine') {
                return engineModule(root);
            }

            if (name === 'config') {
                return `export const files = ${JSON.stringify(files)};`;
            }

            return fs.readFileSync(path.join(SRC_DIR, name + '.js'), 'utf8');
        },

        // head-prepend: el adaptador tiene que parchear el engine antes de que arranque el juego.
        transformIndexHtml() {
            return [{ tag: 'script', attrs: { type: 'module', src: '/@id/' + VIRTUAL_PREFIX + 'panel' }, injectTo: 'head-prepend' }];
        },

        // Que guardar un json de idioma no recargue el juego completo.
        handleHotUpdate({ file }) {
            if (path.resolve(file).startsWith(langRoot + path.sep)) {
                return [];
            }
        },

        configureServer(server) {
            viteServer = server;
            server.watcher.add(langRoot);
            server.watcher.on('change', (abs) => {
                const info = fileIdFromPath(path.resolve(abs));

                if (!info || Date.now() - (ownWrites.get(path.resolve(abs)) || 0) < 2000) {
                    return;
                }

                server.ws.send({ type: 'custom', event: 'info-editor:changed', data: info });
            });

            server.middlewares.use(API_PREFIX, async (req, res) => {
                try {
                    const url = new URL(req.url || '/', 'http://localhost');

                    if (url.pathname === '/meta' && req.method === 'GET') {
                        const langs = listLangs();
                        const available = {};

                        for (const lang of langs) {
                            available[lang] = Object.keys(files).filter((id) => fs.existsSync(filePath(lang, id)));
                        }

                        return send(res, 200, { game: path.basename(root), files, langs, available });
                    }

                    if (url.pathname === '/shutdown' && req.method === 'POST') {
                        send(res, 200, { ok: true });
                        // Se responde primero para que el navegador muestre el aviso antes de que se apague.
                        setTimeout(() => (options.onShutdown ? options.onShutdown() : viteServer.close()), 150);
                        return;
                    }

                    if (url.pathname === '/file') {
                        const lang = url.searchParams.get('lang') || '';
                        const id = url.searchParams.get('file') || '';

                        if (!LANG_RE.test(lang) || !Object.prototype.hasOwnProperty.call(files, id)) {
                            return send(res, 400, { error: 'lang o file inválido' });
                        }

                        const abs = filePath(lang, id);

                        if (req.method === 'GET') {
                            return fs.existsSync(abs)
                                ? send(res, 200, fs.readFileSync(abs, 'utf8'))
                                : send(res, 404, { error: 'no existe ' + path.relative(root, abs) });
                        }

                        if (req.method === 'PUT') {
                            if (!fs.existsSync(path.dirname(abs))) {
                                return send(res, 404, { error: 'no existe la carpeta del idioma' });
                            }

                            const minimal = writeJson(abs, await readBody(req));
                            return send(res, 200, { ok: true, minimal, path: path.relative(root, abs) });
                        }
                    }

                    send(res, 404, { error: 'ruta desconocida' });
                } catch (error) {
                    send(res, 500, { error: String(error && error.message || error) });
                }
            });
        },
    };
}
