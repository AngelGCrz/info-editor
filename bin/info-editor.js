#!/usr/bin/env node
// Arranca el dev server de un juego Pixi con el info-editor conectado.
// No modifica ningún archivo del juego: usa su Vite y su vite.config, y agrega el plugin en memoria.
//
//   info-editor                 elige un juego de la carpeta actual (o ./pixi)
//   info-editor ../pixi/g490    abre ese juego
//   opciones: --lang esp  --port 8090  --no-open

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import infoEditor, { findLanguagesDir } from '../src/plugin.js';

function parseArgs(argv) {
    const args = { game: null, lang: null, port: null, open: true };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '--lang' || arg === '-l') {
            args.lang = argv[++i];
        } else if (arg === '--port' || arg === '-p') {
            args.port = Number(argv[++i]);
        } else if (arg === '--no-open') {
            args.open = false;
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            args.game = arg;
        }
    }

    return args;
}

function isGame(dir) {
    const pkgPath = path.join(dir, 'package.json');

    if (!fs.existsSync(pkgPath) || !findLanguagesDir(dir)) {
        return false;
    }

    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return !!({ ...pkg.dependencies, ...pkg.devDependencies }).vite;
    } catch {
        return false;
    }
}

function listGames(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }

    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map((d) => path.join(dir, d.name))
        .filter(isGame)
        .sort();
}

async function pickGame(cwd) {
    if (isGame(cwd)) {
        return cwd;
    }

    let games = listGames(cwd);

    if (!games.length) {
        games = listGames(path.join(cwd, 'pixi'));
    }

    if (!games.length) {
        throw new Error(`No encontré juegos en ${cwd}. Pasa la ruta: info-editor ../pixi/g490`);
    }

    if (games.length === 1) {
        return games[0];
    }

    if (!process.stdin.isTTY) {
        throw new Error('Hay varios juegos; pasa la ruta como argumento.');
    }

    console.log('\nJuegos encontrados:\n');
    games.forEach((game, i) => console.log(`  ${String(i + 1).padStart(2)}. ${path.basename(game)}`));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\n¿Cuál abro? (número o nombre) ');
    rl.close();

    const byIndex = games[Number(answer) - 1];
    const byName = games.find((game) => path.basename(game) === answer.trim());
    const game = byIndex || byName;

    if (!game) {
        throw new Error(`"${answer}" no es una opción.`);
    }

    return game;
}

// Usa el Vite instalado en el juego, para que sea exactamente el mismo que con `npm run dev`.
async function importGameVite(gameDir) {
    const require = createRequire(path.join(gameDir, 'package.json'));
    let pkgPath;

    try {
        pkgPath = require.resolve('vite/package.json');
    } catch {
        throw new Error(`El juego no tiene Vite instalado. Corre "npm install" en ${gameDir}`);
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const entry = pkg.exports && pkg.exports['.'] && (pkg.exports['.'].import?.default || pkg.exports['.'].import || pkg.exports['.'].default);

    return import(pathToFileURL(path.join(path.dirname(pkgPath), typeof entry === 'string' ? entry : 'dist/node/index.js')).href);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        console.log('Uso: info-editor [carpeta-del-juego] [--lang esp] [--port 8090] [--no-open]');
        return;
    }

    const gameDir = path.resolve(args.game || await pickGame(process.cwd()));

    if (!isGame(gameDir)) {
        throw new Error(`${gameDir} no parece un juego Pixi (falta package.json con vite o assets/languages).`);
    }

    process.chdir(gameDir);
    const vite = await importGameVite(gameDir);
    const openPath = args.lang ? `/?lang=${encodeURIComponent(args.lang)}` : '/';

    const shutdown = async () => {
        console.log('\n  ✎ info-editor cerrado desde el navegador.\n');
        await server.close();
        process.exit(0);
    };

    const server = await vite.createServer({
        root: gameDir,
        plugins: [infoEditor({ onShutdown: shutdown })],
        server: {
            open: args.open ? openPath : false,
            ...(args.port ? { port: args.port } : {}),
        },
    });

    await server.listen();
    console.log(`\n  ✎ info-editor · ${path.basename(gameDir)}\n`);
    server.printUrls();
    server.bindCLIShortcuts?.({ print: true });
}

main().catch((error) => {
    console.error('\n✖ ' + (error && error.message || error));
    process.exit(1);
});
