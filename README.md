# info-editor

Editor visual de los textos del info multidioma (`public/assets/languages/{lang}/info/info.json` y `jackpotpages.json`) para juegos Pixi del engine GDP.

Corre **encima del juego real**: lo que ves es exactamente lo que dibuja `HelpPagesLayer` del engine. **No modifica el juego, el engine, `vite.config.ts` ni `launch.json`**; el único archivo que escribe es el json del idioma cuando guardas.

## Instalar (una vez)

```bash
cd ~/Documents/DPI/info-editor
npm link
```

Esto deja el comando `info-editor` disponible en cualquier carpeta. No tiene dependencias: usa el Vite que ya tiene cada juego.

## Usar

```bash
cd ~/Documents/DPI/pixi
info-editor            # te muestra la lista de juegos y eliges uno
info-editor g490       # abre ese juego
info-editor g490 --lang esp --port 8090
```

Dentro de la carpeta de un juego basta con `info-editor`. Opciones: `--lang xxx`, `--port N`, `--no-open`.

El juego necesita `npm install` hecho (igual que para `npm run dev`).

## En el navegador

- El panel aparece a la derecha (`⟩` lo oculta, `✎ Info` lo vuelve a abrir).
- **Abrir info** entra al estado de info. Las flechas del panel o las del juego cambian de página.
- **Idioma**: el selector recarga el juego en ese idioma (`?lang=esp`).
- **✥ Mover**: arrastra títulos, imágenes o el bloque de renglones sobre el canvas. Flechas del teclado = 1px, Shift = 10px. Mover renglones escribe `items.setting.offset` solo para esa página.
- **Títulos**: texto, tamaño, escala, alineación, offset, color y borde. Vacío = hereda de los ajustes de reglas.
- **Renglones**: cada línea del textarea es un elemento de `lines` (línea vacía = espacio). `+ símbolo` inserta `##sym_X.png##`.
- **Ajustes de reglas**: fuente, interlineado, offset y escala/gapX/gapY de cada símbolo, para todas las páginas de reglas.
- **JSON de la página**: edición cruda para lo que no tenga campo.
- `⚠` avisa cuando un texto se sale del fondo de la página.
- Si el idioma no es `eng`, cada texto muestra el de `eng` como referencia.
- `⌘S` guarda, `⌘Z` / `⇧⌘Z` deshacer/rehacer. Al guardar solo cambia en el archivo el texto de los valores que editaste; el resto (indentación, espacios, saltos de línea, orden, escapes) queda igual, así que el diff de git muestra solo tus cambios (`src/jsonpatch.js`).
- Las páginas de doubleup vienen de `common` y solo se pueden ver.
- **⏻ Cerrar editor**: si hay cambios pregunta si guardarlos, apaga el servidor del juego y cierra la pestaña (o deja un aviso con los archivos guardados si el navegador no permite cerrarla). También puedes cerrarlo con `Ctrl+C` o `q` en la terminal.

## Cómo funciona

```
bin/info-editor.js   CLI: elige el juego, importa SU Vite y arranca el dev server
                     con su vite.config + el plugin del editor (solo en memoria).
src/plugin.js        Plugin de Vite: API local para leer/guardar los json e inyecta
                     el panel en el index.html servido (no en el archivo).
src/adapter.js       Extiende HelpPagesLayer y GdpBoot del engine en tiempo de ejecución,
                     antes de que arranque el juego (rebuild, showPage, ?lang=).
src/panel.js         El panel (DOM puro, sin dependencias).
```

El adaptador depende de estos métodos del engine: `HelpPagesLayer.initialize`, `createPage`, `_createTitle`, `_createImage`, `_createItems`, `show`, `updateBackground`, `updateLogo`, `GdpBoot.getCasinoData` y `GDP.Loader.get`. Si alguno cambia de nombre, el panel muestra "Engine no compatible, falta: …" en lugar de fallar en silencio; hay que ajustar `src/adapter.js`.

Probado con g402 y g490 (engine actual). g475 y g500 usan los mismos métodos.
