// Escribe un json cambiando solo el texto de los valores que cambiaron.
// Todo lo demás (indentación, espacios, saltos de línea, orden, escapes, números como "1.0")
// queda byte por byte igual que en el archivo original, para que el diff de git sea mínimo.

// ---------- parser con posiciones ----------

// Devuelve el árbol del json con { type, start, end } y sus hijos:
//   object: entries [{ key, start (inicio de la key), end (fin del valor), value }]
//   array:  items   [{ start, end, value }]
function parseWithRanges(text) {
    let i = 0;

    const fail = (message) => {
        throw new SyntaxError(`${message} en la posición ${i}`);
    };

    const skipWhitespace = () => {
        while (i < text.length && ' \t\n\r﻿'.includes(text[i])) {
            i++;
        }
    };

    const readString = () => {
        const start = i;

        if (text[i] !== '"') {
            fail('Se esperaba "');
        }

        i++;

        while (i < text.length && text[i] !== '"') {
            i += text[i] === '\\' ? 2 : 1;
        }

        if (i >= text.length) {
            fail('String sin cerrar');
        }

        i++;
        return text.slice(start, i);
    };

    const readValue = () => {
        skipWhitespace();
        const start = i;
        const char = text[i];

        if (char === '{' || char === '[') {
            const isObject = char === '{';
            const close = isObject ? '}' : ']';
            const children = [];
            i++;
            skipWhitespace();

            if (text[i] === close) {
                i++;
                return { type: isObject ? 'object' : 'array', start, end: i, children };
            }

            for (;;) {
                skipWhitespace();
                const childStart = i;
                let key;

                if (isObject) {
                    key = JSON.parse(readString());
                    skipWhitespace();

                    if (text[i] !== ':') {
                        fail('Se esperaba :');
                    }

                    i++;
                }

                const value = readValue();
                children.push({ key, start: childStart, end: value.end, value });
                skipWhitespace();

                if (text[i] === ',') {
                    i++;
                    continue;
                }

                if (text[i] !== close) {
                    fail(`Se esperaba , o ${close}`);
                }

                i++;
                return { type: isObject ? 'object' : 'array', start, end: i, children };
            }
        }

        if (char === '"') {
            readString();
            return { type: 'primitive', start, end: i };
        }

        const match = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));

        if (!match) {
            fail('Valor inválido');
        }

        i += match[0].length;
        return { type: 'primitive', start, end: i };
    };

    const root = readValue();
    skipWhitespace();

    if (i !== text.length) {
        fail('Texto extra al final');
    }

    return root;
}

// ---------- utilidades ----------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function deepEqual(a, b) {
    if (a === b) {
        return true;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
    }

    if (isObject(a) && isObject(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((key) => has(b, key) && deepEqual(a[key], b[key]));
    }

    return false;
}

function detectStyle(text) {
    const indentMatch = text.match(/^[\r\n]*[{[][\r\n]+([ \t]+)/);

    return {
        unit: indentMatch ? indentMatch[1] : '    ',
        eol: text.includes('\r\n') ? '\r\n' : '\n',
    };
}

// Sangría de la línea donde empieza `pos`.
function lineIndent(text, pos) {
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    return /^[ \t]*/.exec(text.slice(lineStart, pos))[0];
}

// ---------- diff -> ediciones de texto ----------

function createPatcher(text) {
    const style = detectStyle(text);
    const edits = [];

    // Serializa un valor nuevo con el estilo del archivo, sangrado a partir de `indent`.
    const serialize = (value, indent, inline) => {
        if (inline) {
            return JSON.stringify(value);
        }

        return JSON.stringify(value, null, style.unit).replace(/\n/g, style.eol + indent);
    };

    // Separador entre elementos (", " o ",\n    ") tomado del propio contenedor.
    const separatorOf = (node, index = 1) => {
        const { children } = node;

        if (children.length > 1) {
            const k = Math.min(Math.max(index, 1), children.length - 1);
            return text.slice(children[k - 1].end, children[k].start);
        }

        if (children.length === 1) {
            return ',' + text.slice(node.start + 1, children[0].start);
        }

        return null;
    };

    // Sangría de los elementos según el separador; inline si no hay salto de línea.
    const childIndent = (separator) => {
        const newline = separator.lastIndexOf('\n');
        return newline === -1 ? null : separator.slice(newline + 1);
    };

    const replace = (start, end, value) => edits.push({ start, end, value });

    const replaceNode = (node, newValue) => {
        const multiline = text.slice(node.start, node.end).includes('\n') || typeof newValue === 'object';
        replace(node.start, node.end, serialize(newValue, lineIndent(text, node.start), !multiline));
    };

    // Quita elementos sin tocar el formato del resto.
    const removeChildren = (node, removed) => {
        const { children } = node;
        const firstKept = children.findIndex((_, i) => !removed.has(i));

        if (firstKept > 0) {
            replace(children[0].start, children[firstKept].start, '');
        }

        for (let i = firstKept + 1; i < children.length; i++) {
            if (removed.has(i)) {
                replace(children[i - 1].end, children[i].end, '');
            }
        }
    };

    const formatEntry = (key, value, indent, inline) => {
        const content = serialize(value, indent || '', inline);
        return key === undefined ? content : `${JSON.stringify(key)}: ${content}`;
    };

    const diffObject = (node, oldValue, newValue) => {
        const removed = new Set();

        node.children.forEach((child, i) => {
            if (!has(newValue, child.key)) {
                removed.add(i);
            } else {
                diff(child.value, oldValue[child.key], newValue[child.key]);
            }
        });

        const added = Object.keys(newValue).filter((key) => !has(oldValue, key));

        if (removed.size === node.children.length) {
            // No queda nada del original: se escribe el objeto completo.
            replaceNode(node, newValue);
            return;
        }

        removeChildren(node, removed);

        if (added.length) {
            const separator = separatorOf(node, node.children.length - 1);
            const indent = childIndent(separator);
            const last = node.children[node.children.length - 1];
            replace(last.end, last.end, added.map((key) => separator + formatEntry(key, newValue[key], indent, indent === null)).join(''));
        }
    };

    const diffArray = (node, oldValue, newValue) => {
        const { children } = node;
        let prefix = 0;
        let suffix = 0;

        while (prefix < oldValue.length && prefix < newValue.length && deepEqual(oldValue[prefix], newValue[prefix])) {
            prefix++;
        }

        while (suffix < oldValue.length - prefix && suffix < newValue.length - prefix
            && deepEqual(oldValue[oldValue.length - 1 - suffix], newValue[newValue.length - 1 - suffix])) {
            suffix++;
        }

        const oldCount = oldValue.length - prefix - suffix;
        const newItems = newValue.slice(prefix, newValue.length - suffix);

        // Mismo número de elementos: se compara uno a uno y solo cambia el que cambió.
        if (oldCount === newItems.length) {
            for (let i = 0; i < oldCount; i++) {
                diff(children[prefix + i].value, oldValue[prefix + i], newItems[i]);
            }

            return;
        }

        if (newItems.length === 0 && oldCount === children.length) {
            replaceNode(node, newValue);
            return;
        }

        if (newItems.length === 0) {
            removeChildren(node, new Set(Array.from({ length: oldCount }, (_, i) => prefix + i)));
            return;
        }

        const separator = separatorOf(node, prefix || 1);
        const indent = childIndent(separator);
        const items = newItems.map((value) => formatEntry(undefined, value, indent, indent === null));

        if (oldCount > 0) {
            replace(children[prefix].start, children[prefix + oldCount - 1].end, items.join(separator));
        } else if (prefix > 0) {
            replace(children[prefix - 1].end, children[prefix - 1].end, items.map((item) => separator + item).join(''));
        } else {
            replace(children[0].start, children[0].start, items.map((item) => item + separator).join(''));
        }
    };

    const diff = (node, oldValue, newValue) => {
        if (deepEqual(oldValue, newValue)) {
            return;
        }

        if (node.type === 'object' && isObject(oldValue) && isObject(newValue) && node.children.length) {
            diffObject(node, oldValue, newValue);
        } else if (node.type === 'array' && Array.isArray(oldValue) && Array.isArray(newValue) && node.children.length) {
            diffArray(node, oldValue, newValue);
        } else {
            replaceNode(node, newValue);
        }
    };

    const apply = () => {
        let out = text;

        // De atrás hacia adelante para no mover las posiciones pendientes.
        // Con el mismo inicio, primero lo que borra/reemplaza y después la inserción (start === end),
        // para que el borrado no se lleve el texto recién insertado.
        const isInsert = (edit) => (edit.start === edit.end ? 1 : 0);
        edits
            .sort((a, b) => b.start - a.start || isInsert(a) - isInsert(b))
            .forEach(({ start, end, value }) => {
                out = out.slice(0, start) + value + out.slice(end);
            });

        return out;
    };

    return { diff, apply };
}

/**
 * Aplica `newValue` sobre el texto json original cambiando solo lo necesario.
 * @returns {{ text: string, minimal: boolean }} minimal=false si hubo que reescribir el archivo completo.
 */
export function patchJson(originalText, newValue) {
    const oldValue = JSON.parse(originalText);
    const style = detectStyle(originalText);

    try {
        const tree = parseWithRanges(originalText);
        const patcher = createPatcher(originalText);
        patcher.diff(tree, oldValue, newValue);
        const text = patcher.apply();

        if (deepEqual(JSON.parse(text), newValue)) {
            return { text, minimal: true };
        }
    } catch {
        // Si algo no cuadra se cae al formato completo, que siempre es json válido.
    }

    let text = JSON.stringify(newValue, null, style.unit).replace(/\n/g, style.eol);

    if (/\r?\n$/.test(originalText)) {
        text += style.eol;
    }

    return { text, minimal: false };
}
