// Adaptador del engine: agrega en tiempo de ejecución lo que el editor necesita,
// sin modificar ningún archivo del juego ni del engine.
//
// Se carga antes que el juego (script head-prepend), así que parchea los prototipos
// de HelpPagesLayer y GdpBoot antes de que se cree cualquier instancia:
//   - GdpBoot.getCasinoData: respeta ?lang=xxx.
//   - HelpPagesLayer.createPage/_createTitle/_createImage/_createItems: ligan cada objeto
//     de pixi con su config (__infoSource) para saber qué nodo del json editar.
//   - HelpPagesLayer.rebuild(overrides) / showPage(i): nuevos, para la vista previa.
import { GDP, GdpBoot, HelpPagesLayer, engineError } from 'virtual:info-editor/engine';
import { files } from 'virtual:info-editor/config';

const REQUIRED = ['initialize', 'createPage', '_createTitle', '_createImage', '_createItems', 'show', 'updateBackground', 'updateLogo'];
const RESET_FIELDS = {
    backgrounds: () => ({}),
    buttons: () => [],
    logos: () => ({}),
    pageCount: () => 0,
    pages: () => [],
    pays: () => ({}),
    paysConfig: () => ({}),
    paysJackpot: () => ({}),
    previousBackgroundKey: () => null,
    previousLogoKey: () => null,
};

export const lang = new URLSearchParams(location.search).get('lang');

// key del editor ('game', 'jackpot') -> key del Loader ('game_helppage_json', ...)
const loaderKeys = Object.fromEntries(Object.values(files).map((file) => [file.key, file.loaderKey]));

function checkEngine() {
    if (engineError) {
        return engineError;
    }

    const proto = HelpPagesLayer && HelpPagesLayer.prototype;
    const missing = REQUIRED.filter((name) => !proto || typeof proto[name] !== 'function');

    if (!GDP || !GDP.Loader || typeof GDP.Loader.get !== 'function') {
        missing.push('GDP.Loader.get');
    }

    return missing.length ? 'Engine no compatible, falta: ' + missing.join(', ') : null;
}

export const adapterError = checkEngine();

function wrap(proto, name, makeWrapper) {
    const original = proto[name];
    proto[name] = makeWrapper(original);
}

function tag(obj, config) {
    if (obj && typeof obj === 'object' && config && typeof config === 'object') {
        obj.__infoSource = config;
    }

    return obj;
}

// Durante un rebuild el Loader devuelve los json del editor (y copias limpias del resto,
// porque el engine muta sus configs al crear las páginas, p. ej. los offsets de tips).
function withLoaderOverrides(overrides, pristine, run) {
    const loader = GDP.Loader;
    const hadOwn = Object.prototype.hasOwnProperty.call(loader, 'get');
    const previous = loader.get;
    const byLoaderKey = {};

    for (const key of Object.keys(overrides)) {
        byLoaderKey[loaderKeys[key] || key] = overrides[key];
    }

    loader.get = function (key, ...rest) {
        if (Object.prototype.hasOwnProperty.call(byLoaderKey, key)) {
            return byLoaderKey[key];
        }

        if (Object.prototype.hasOwnProperty.call(pristine, key)) {
            return structuredClone(pristine[key]);
        }

        return previous.call(this, key, ...rest);
    };

    try {
        return run();
    } finally {
        if (hadOwn) {
            loader.get = previous;
        } else {
            delete loader.get;
        }
    }
}

function patchHelpPages() {
    const proto = HelpPagesLayer.prototype;
    const pristineKeys = [...new Set([...Object.values(loaderKeys), 'du_helppage_json', 'info_tips'])];

    wrap(proto, 'initialize', (original) => function (...args) {
        // Copia de los json tal como los cargó el juego, antes de que el engine los mute.
        if (!this.__infoPristine) {
            this.__infoPristine = {};

            for (const key of pristineKeys) {
                const value = GDP.Loader.get(key);

                if (value !== undefined) {
                    this.__infoPristine[key] = structuredClone(value);
                }
            }
        }

        const result = this.__infoOverrides
            ? withLoaderOverrides(this.__infoOverrides, this.__infoPristine, () => original.apply(this, args))
            : original.apply(this, args);

        if (window.__gdpHelpPagesLayer !== this) {
            window.__gdpHelpPagesLayer = this;
            window.dispatchEvent(new CustomEvent('gdp:helppages-ready', { detail: this }));
        }

        return result;
    });

    wrap(proto, 'createPage', (original) => function (config, ...rest) {
        const result = original.call(this, config, ...rest);
        tag(this.pages[this.pages.length - 1], config);
        return result;
    });

    for (const name of ['_createTitle', '_createImage', '_createItems']) {
        wrap(proto, name, (original) => function (config, ...rest) {
            return tag(original.call(this, config, ...rest), config);
        });
    }

    proto.rebuild = function (overrides = {}) {
        const wasVisible = this.visible;
        const pageId = this.pageId || 0;

        if (this.pages && this.pages[pageId]) {
            this.pages[pageId].visible = false;
        }

        for (const child of this.canvas.removeChildren()) {
            child.destroy({ children: true });
        }

        for (const [field, reset] of Object.entries(RESET_FIELDS)) {
            if (field in this) {
                this[field] = reset();
            }
        }

        this.__infoOverrides = overrides;
        this.initialize();

        // initialize() vuelve a hacer addChild(darkBackground); pixi lo deja al final sin reordenar por zIndex.
        if (this.darkBackground && this.darkBackground.parent === this) {
            this.setChildIndex(this.darkBackground, 0);
        }

        this.pageId = Math.max(0, Math.min(pageId, this.pages.length - 1));

        if (wasVisible) {
            this.show();
        } else {
            this.visible = false;
        }
    };

    proto.showPage = function (pageId) {
        if (!this.pages[pageId]) {
            return;
        }

        this.pages[this.pageId].visible = false;
        this.pageId = pageId;
        this.updateBackground();
        this.updateLogo();
        this.pages[this.pageId].visible = this.visible;
    };
}

function patchLang() {
    if (!lang || !GdpBoot || typeof GdpBoot.prototype.getCasinoData !== 'function') {
        return;
    }

    wrap(GdpBoot.prototype, 'getCasinoData', (original) => function (...args) {
        const casino = original.apply(this, args);
        casino.lang = lang;
        return casino;
    });
}

if (!adapterError) {
    patchHelpPages();
    patchLang();
} else {
    console.warn('[info-editor]', adapterError);
}
