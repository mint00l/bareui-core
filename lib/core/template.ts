import { effect, popEffectOwner, pushEffectOwner } from './reactivity';
import type { EffectOwner } from '../types/reactivity.types';
import type {
    AttrPart,
    CompiledPart,
    CompiledTemplate,
    ContentPart,
    EventPart,
    Part,
    Renderable,
    Source,
    TemplateResultLike,
} from '../types/template.types';
import { runCallbacks } from '../utils';

const INIT = Symbol('init');

/**
 * Caches parsed templates by TemplateStringsArray identity.
 * The same tagged template literal site always reuses the same array object,
 * so this is a safe and fast cache key.
 */
const TEMPLATE_CACHE = new WeakMap<TemplateStringsArray, CompiledTemplate>();

let currentComponent: EffectOwner | null = null;

/**
 * Type guard for TemplateResult instances.
 */
function isTemplateResult(value: unknown): value is TemplateResult {
    return value instanceof TemplateResult;
}

/**
 * Builds the raw HTML string for a tagged template literal.
 * Each placeholder is replaced with a marker comment so the parser can
 * later identify binding locations.
 */
function buildTemplateMarkup(strings: TemplateStringsArray): string {
    let markup = '';

    for (let i = 0; i < strings.length; i++) {
        markup += strings[i];
        if (i < strings.length - 1) {
            markup += `<!--rf-${i}-->`;
        }
    }

    return markup;
}

/**
 * Returns the path from the root node to a target node.
 * The path is stored as child-node indexes so it can be resolved again on a
 * cloned fragment without reparsing the template HTML.
 */
function getNodePath(root: Node, node: Node): number[] {
    const path: number[] = [];
    let current: Node | null = node;

    while (current && current !== root) {
        const parent: ParentNode | null = current.parentNode;

        if (!parent) {
            throw new Error('compileTemplate(): template node is detached');
        }

        const index = Array.prototype.indexOf.call(parent.childNodes, current);

        if (index < 0) {
            throw new Error('compileTemplate(): failed to compute node path');
        }

        path.unshift(index);
        current = parent;
    }

    return path;
}

/**
 * Resolves a stored node path inside a cloned fragment.
 * Returns null when the path cannot be resolved.
 */
function resolveNodePath(root: ParentNode, path: number[]): Node | null {
    let current: Node = root as unknown as Node;

    for (const index of path) {
        const next = current.childNodes.item(index);

        if (!next) return null;
        current = next;
    }

    return current;
}

/**
 * Compiles a tagged template literal once.
 * The template HTML is parsed, placeholder locations are recorded, and the
 * parsed DOM is mutated into a reusable compiled shape.
 */
function compileTemplate(strings: TemplateStringsArray): CompiledTemplate {
    const markup = buildTemplateMarkup(strings);
    const template = document.createElement('template');

    template.innerHTML = markup;

    const parts: CompiledPart[] = [];

    /**
     * First collect comment placeholders and turn each one into a start/end
     * marker pair in the compiled template.
     */
    const commentWalker = document.createTreeWalker(template.content, NodeFilter.SHOW_COMMENT);
    const comments: Comment[] = [];

    while (commentWalker.nextNode()) {
        comments.push(commentWalker.currentNode as Comment);
    }

    for (const node of comments) {
        const match = /^rf-(\d+)$/.exec(node.nodeValue || '');
        if (!match) continue;

        const index = Number(match[1]);
        const path = getNodePath(template.content, node);
        const parent = node.parentNode!;

        const start = document.createComment(`rf-${index}-start`);
        const end = document.createComment(`rf-${index}-end`);

        parent.replaceChild(end, node);
        parent.insertBefore(start, end);

        parts.push({
            kind: 'content',
            index,
            path,
        });
    }

    /**
     * Then collect attribute and event placeholders from elements.
     */
    const elementWalker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
    let node: Element | null;

    while ((node = elementWalker.nextNode() as Element | null)) {
        const element = node;

        for (const attr of Array.from(element.attributes)) {
            const name = attr.name;
            const rawValue = attr.value;
            const match = /^<!--rf-(\d+)-->$/.exec(rawValue);

            if (!match) continue;

            const index = Number(match[1]);
            const path = getNodePath(template.content, element);

            if (name.startsWith(':')) {
                const attrName = name.slice(1);
                element.removeAttribute(name);

                parts.push({
                    kind: 'attr',
                    index,
                    path,
                    attrName,
                });
            } else if (name.startsWith('@')) {
                const eventName = name.slice(1);
                element.removeAttribute(name);

                parts.push({
                    kind: 'event',
                    index,
                    path,
                    eventName,
                });
            }
        }
    }

    return {
        template,
        parts,
    };
}

/**
 * Returns the compiled template for a tagged template literal, creating and
 * caching it on first use.
 */
function getCompiledTemplate(strings: TemplateStringsArray): CompiledTemplate {
    const cached = TEMPLATE_CACHE.get(strings);
    if (cached) return cached;

    const compiled = compileTemplate(strings);
    TEMPLATE_CACHE.set(strings, compiled);
    return compiled;
}

/**
 * Creates runtime binding parts for a cloned template fragment.
 * The cached paths are resolved against the clone so the template is not
 * reparsed or rescanned on subsequent renders.
 */
function createRuntimeParts(definitions: CompiledPart[], fragment: DocumentFragment): Part[] {
    const parts: Part[] = [];

    for (const definition of definitions) {
        const target = resolveNodePath(fragment, definition.path);

        if (!target) {
            throw new Error('html(): failed to resolve a compiled binding location');
        }

        if (definition.kind === 'content') {
            if (!(target instanceof Comment)) {
                throw new Error('html(): expected a comment marker for content binding');
            }

            const end = target.nextSibling;
            if (!(end instanceof Comment)) {
                throw new Error('html(): failed to resolve the end marker for content binding');
            }

            parts.push({
                kind: 'content',
                index: definition.index,
                start: target,
                end,
                cleanups: [],
                textNode: null,
                last: INIT,
            } as ContentPart);

            continue;
        }

        if (!(target instanceof Element)) {
            throw new Error('html(): expected an element for attribute or event binding');
        }

        if (definition.kind === 'attr') {
            parts.push({
                kind: 'attr',
                index: definition.index,
                element: target,
                attrName: definition.attrName,
                last: INIT,
            } as AttrPart);

            continue;
        }

        parts.push({
            kind: 'event',
            index: definition.index,
            element: target,
            eventName: definition.eventName,
            listener: null,
            last: INIT,
        } as EventPart);
    }

    return parts;
}

/**
 * Clears all DOM nodes between two comment markers.
 */
function clearBetween(start: Comment, end: Comment): void {
    let node = start.nextSibling;

    while (node && node !== end) {
        const next = node.nextSibling;
        node.parentNode?.removeChild(node);
        node = next;
    }
}

/**
 * Returns true when a value can be rendered as a single text node.
 */
function isPrimitiveTextValue(value: unknown): value is string | number | bigint {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
}

/**
 * Appends a renderable value into a parent node.
 * Nested arrays are flattened, nested template results are mounted lazily,
 * and primitives are converted into text nodes.
 */
function appendRenderable(
    parent: Node,
    value: Renderable,
    cleanups: Array<() => void>
): void {
    if (value === null || value === undefined || value === false) return;

    if (Array.isArray(value)) {
        for (const item of value) {
            appendRenderable(parent, item, cleanups);
        }
        return;
    }

    if (isTemplateResult(value)) {
        parent.appendChild(value.fragment);
        cleanups.push(() => value.dispose());
        scheduleMount(value);
        return;
    }

    if (value instanceof Node) {
        parent.appendChild(value);
        return;
    }

    parent.appendChild(document.createTextNode(String(value)));
}

/**
 * Applies an attribute binding to an element.
 * Special-cases common DOM properties so bindings behave naturally for form
 * controls and boolean attributes.
 */
function setAttrBinding(element: Element, attrName: string, value: unknown): void {
    if (attrName === 'value') {
        if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
        ) {
            element.value = value == null ? '' : String(value);
        } else {
            if (value === false || value === null || value === undefined) {
                element.removeAttribute(attrName);
            } else {
                element.setAttribute(attrName, String(value));
            }
        }
        return;
    }

    if (attrName === 'checked') {
        if (element instanceof HTMLInputElement) {
            element.checked = Boolean(value);
        }

        if (value) {
            element.setAttribute(attrName, '');
        } else {
            element.removeAttribute(attrName);
        }
        return;
    }

    if (attrName === 'disabled') {
        if (
            element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLOptGroupElement ||
            element instanceof HTMLOptionElement
        ) {
            element.disabled = Boolean(value);
        }

        if (value) {
            element.setAttribute(attrName, '');
        } else {
            element.removeAttribute(attrName);
        }
        return;
    }

    if (attrName === 'selected') {
        if (element instanceof HTMLOptionElement) {
            element.selected = Boolean(value);
        }

        if (value) {
            element.setAttribute(attrName, '');
        } else {
            element.removeAttribute(attrName);
        }
        return;
    }

    if (value === false || value === null || value === undefined) {
        element.removeAttribute(attrName);
    } else if (value === true) {
        element.setAttribute(attrName, '');
    } else {
        element.setAttribute(attrName, String(value));
    }
}

/**
 * Normalizes a root renderable into a TemplateResult.
 * Plain values are wrapped in a fragment so the mount/update pipeline always
 * works against a single template result object.
 */
function normalizeRootValue(value: Renderable): TemplateResult {
    if (isTemplateResult(value)) return value;

    const fragment = document.createDocumentFragment();
    const result = new TemplateResult(fragment);

    appendRenderable(fragment, value, result.cleanups);
    return result;
}

/**
 * Schedules mounted callbacks to run in a microtask.
 * This keeps mount timing predictable and avoids running mount handlers before
 * the fragment is actually inserted.
 */
function scheduleMount(result: TemplateResult): void {
    if (!result || result.disposed || result.mounted || result.mountScheduled) return;

    result.mountScheduled = true;
    queueMicrotask(() => {
        result.mountScheduled = false;
        result.runMounts();
    });
}

/**
 * Represents a rendered template fragment and its lifecycle callbacks.
 */
export class TemplateResult implements TemplateResultLike {
    fragment: DocumentFragment;
    cleanups: Array<() => void>;
    mounts: Array<() => void>;
    disposed: boolean;
    mounted: boolean;
    mountScheduled: boolean;
    keyFn: (() => unknown) | null;

    constructor(fragment: DocumentFragment) {
        this.fragment = fragment;
        this.cleanups = [];
        this.mounts = [];
        this.disposed = false;
        this.mounted = false;
        this.mountScheduled = false;
        this.keyFn = null;
    }

    /**
     * Registers a cleanup callback.
     */
    addCleanup(fn: () => void): void {
        if (typeof fn === 'function') {
            this.cleanups.push(fn);
        }
    }

    /**
     * Registers a mount callback.
     */
    addMount(fn: () => void): void {
        if (typeof fn === 'function') {
            this.mounts.push(fn);
        }
    }

    /**
     * Runs mount callbacks once.
     */
    runMounts(): void {
        if (this.disposed || this.mounted) return;

        this.mounted = true;
        runCallbacks(this.mounts);
        this.mounts.length = 0;
    }

    /**
     * Disposes the fragment and all registered cleanup callbacks.
     */
    dispose(): void {
        if (this.disposed) return;

        this.disposed = true;
        runCallbacks(this.cleanups);
        this.cleanups.length = 0;
        this.mounts.length = 0;
    }

    /**
     * Returns the current key for keyed rendering, if one was declared.
     */
    getKey(): unknown {
        return this.keyFn ? this.keyFn() : undefined;
    }
}

/**
 * Runs when the component's rendered fragment has been mounted.
 */
export function onMounted(fn: () => void): void {
    if (currentComponent) currentComponent.mounts.push(fn);
}

/**
 * Runs when the component is being disposed.
 */
export function onUnmounted(fn: () => void): void {
    if (currentComponent) currentComponent.cleanups.push(fn);
}

/**
 * Wraps a render function in a component scope.
 * Component mounts, cleanups, and nested effects are tied to the returned result.
 */
export function component<P extends any[] = any[]>(
    renderFn: (...args: P) => Renderable
): (...args: P) => TemplateResult {
    return (...args: P) => {
        const prev = currentComponent;

        const scope: EffectOwner = {
            mounts: [],
            cleanups: [],
            effects: new Set(),
            disposed: false,
        };

        currentComponent = scope;
        pushEffectOwner(scope);

        try {
            const rendered = renderFn(...args);
            const result = normalizeRootValue(rendered);

            for (const fn of scope.mounts) {
                result.addMount(fn);
            }

            result.addCleanup(() => {
                if (scope.disposed) return;

                scope.disposed = true;
                runCallbacks(scope.cleanups);

                for (const runner of Array.from(scope.effects)) {
                    runner.stop();
                }

                scope.effects.clear();
            });

            return result;
        } finally {
            popEffectOwner();
            currentComponent = prev;
        }
    };
}

/**
 * Creates a template result from a tagged template literal.
 * Parsed template DOM and binding metadata are cached by template literal
 * identity so repeated renders skip reparsing work.
 */
export function html(
    strings: TemplateStringsArray,
    ...values: Array<unknown>
): TemplateResult {
    const compiled = getCompiledTemplate(strings);
    const fragment = compiled.template.content.cloneNode(true) as DocumentFragment;
    const result = new TemplateResult(fragment);
    const parts = createRuntimeParts(compiled.parts, fragment);

    const keyPart = parts.find(
        p => p.kind === 'attr' && p.attrName === 'key'
    ) as AttrPart | undefined;

    if (keyPart) {
        result.keyFn = () => keyPart.last;
    }

    const runner = effect(() => {
        for (const part of parts) {
            const source = values[part.index];

            if (part.kind === 'content') {
                const resolved = typeof source === 'function'
                    ? (source as () => unknown)()
                    : source;

                if (Object.is(resolved, part.last)) continue;
                part.last = resolved;

                runCallbacks(part.cleanups);
                part.cleanups.length = 0;

                if (resolved === null || resolved === undefined || resolved === false) {
                    clearBetween(part.start, part.end);
                    part.textNode = null;
                    continue;
                }

                if (isPrimitiveTextValue(resolved)) {
                    const text = String(resolved);

                    if (part.textNode && part.textNode.parentNode) {
                        part.textNode.data = text;
                    } else {
                        clearBetween(part.start, part.end);
                        part.textNode = document.createTextNode(text);
                        part.end.parentNode!.insertBefore(part.textNode, part.end);
                    }

                    continue;
                }

                clearBetween(part.start, part.end);
                part.textNode = null;

                const temp = document.createDocumentFragment();
                appendRenderable(temp, resolved as Renderable, part.cleanups);
                part.end.parentNode!.insertBefore(temp, part.end);
                continue;
            }

            if (part.kind === 'attr') {
                const resolved = typeof source === 'function'
                    ? (source as () => unknown)()
                    : source;

                if (Object.is(resolved, part.last)) continue;
                part.last = resolved;

                // :key is used for identity only, not as a real DOM attribute.
                if (part.attrName !== 'key') {
                    setAttrBinding(part.element, part.attrName, resolved);
                }

                continue;
            }

            if (part.kind === 'event') {
                const handler = source;

                if (handler === part.last) continue;
                part.last = handler;

                if (part.listener) {
                    part.element.removeEventListener(part.eventName, part.listener);
                    part.listener = null;
                }

                if (typeof handler === 'function') {
                    const owner = currentComponent;
                    const wrapped: EventListener = function (this: unknown, ...args: unknown[]) {
                        if (owner) pushEffectOwner(owner);
                        try {
                            return (handler as EventListener).apply(this, args as never);
                        } finally {
                            if (owner) popEffectOwner();
                        }
                    };

                    part.listener = wrapped;
                    part.element.addEventListener(part.eventName, wrapped);
                }
            }
        }
    });

    result.addCleanup(() => runner.stop());
    return result;
}

/**
 * Renders and keeps a keyed list of child template results in sync.
 */
export function repeat<T>(
    items: Source<T[]>,
    keyFn: (item: T) => unknown,
    renderItem: (item: T) => TemplateResult
): TemplateResult {
    const start = document.createComment('repeat-start');
    const end = document.createComment('repeat-end');

    const frag = document.createDocumentFragment();
    frag.append(start, end);

    const result = new TemplateResult(frag);
    const entries = new Map<unknown, { child: TemplateResult; nodes: Node[] }>();

    /**
     * Collects the keys currently present in the list.
     */
    function collectKeys(list: T[]): Set<unknown> {
        const keys = new Set<unknown>();

        for (const item of list) {
            keys.add(keyFn(item));
        }

        return keys;
    }

    const runner = effect(() => {
        const list = typeof items === 'function' ? items() : items;
        const nextKeys = collectKeys(list);
        const orderedNodes: Node[] = [];

        for (const item of list) {
            const key = keyFn(item);
            let entry = entries.get(key);

            if (!entry) {
                const child = renderItem(item);

                if (!isTemplateResult(child)) {
                    throw new Error('repeat(): renderItem must return html`...`');
                }

                entry = {
                    child,
                    nodes: Array.from(child.fragment.childNodes),
                };

                entries.set(key, entry);
            }

            orderedNodes.push(...entry.nodes);
        }

        for (const [key, entry] of entries.entries()) {
            if (!nextKeys.has(key)) {
                entry.child.dispose();
                entries.delete(key);
            }
        }

        clearBetween(start, end);

        const temp = document.createDocumentFragment();
        for (const node of orderedNodes) {
            temp.appendChild(node);
        }

        end.parentNode!.insertBefore(temp, end);
    });

    result.addCleanup(() => {
        runner.stop();

        for (const entry of entries.values()) {
            entry.child.dispose();
        }

        entries.clear();
    });

    return result;
}

/**
 * Mounts a template result or render function into a container element.
 * Returns an unmount function that disposes the current fragment and clears
 * the host node.
 */
export function mount(
    view: TemplateResult | Source<Renderable>,
    container: Element | string
): () => void {
    const host =
        typeof container === 'string'
            ? document.querySelector<Element>(container)
            : container;

    if (!host) throw new Error('mount: container not found');

    let current: TemplateResult | null = null;

    const runner = effect(() => {
        if (current) {
            current.dispose();
            current = null;
        }

        const rendered = typeof view === 'function' ? view() : view;
        current = isTemplateResult(rendered) ? rendered : normalizeRootValue(rendered);

        host.replaceChildren(current.fragment);
        scheduleMount(current);
    });

    return () => {
        if (current) {
            current.dispose();
            current = null;
        }

        runner.stop();
        host.replaceChildren();
    };
}