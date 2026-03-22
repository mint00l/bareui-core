/**
 * A function or plain value source used by template bindings.
 */
export type Source<T> = T | (() => T);

/**
 * A value that can be rendered into the DOM.
 *
 * This is the main render contract used by the template runtime.
 * It allows plain DOM nodes, primitive values, nested arrays, and
 * template results to all be used in one rendering pipeline.
 */
export type Renderable =
    | TemplateResultLike
    | Node
    | string
    | number
    | bigint
    | boolean
    | null
    | undefined
    | Renderable[];

/**
 * Minimal shape used by template helpers.
 * This keeps the type layer independent from the concrete class implementation.
 */
export interface TemplateResultLike {
    readonly fragment: DocumentFragment;
    dispose(): void;
}

/**
 * Internal base shape shared by runtime binding parts.
 */
export type PartBase = {
    index: number;
    last: unknown;
};

/**
 * Runtime content binding that owns a DOM range between two comment markers.
 */
export type ContentPart = PartBase & {
    kind: 'content';
    start: Comment;
    end: Comment;
    cleanups: Array<() => void>;
    textNode: Text | null;
};

/**
 * Runtime attribute binding attached to a specific element.
 */
export type AttrPart = PartBase & {
    kind: 'attr';
    element: Element;
    attrName: string;
};

/**
 * Runtime event binding attached to a specific element.
 */
export type EventPart = PartBase & {
    kind: 'event';
    element: Element;
    eventName: string;
    listener: EventListener | null;
};

/**
 * Union of all runtime binding parts used while rendering.
 */
export type Part = ContentPart | AttrPart | EventPart;

/**
 * Cached content binding location inside a compiled template.
 */
export type CompiledContentPart = {
    kind: 'content';
    index: number;
    path: number[];
};

/**
 * Cached attribute binding location inside a compiled template.
 */
export type CompiledAttrPart = {
    kind: 'attr';
    index: number;
    path: number[];
    attrName: string;
};

/**
 * Cached event binding location inside a compiled template.
 */
export type CompiledEventPart = {
    kind: 'event';
    index: number;
    path: number[];
    eventName: string;
};

/**
 * Union of all cached binding locations for a template literal.
 */
export type CompiledPart = CompiledContentPart | CompiledAttrPart | CompiledEventPart;

/**
 * Fully compiled template information stored in the cache.
 */
export type CompiledTemplate = {
    template: HTMLTemplateElement;
    parts: CompiledPart[];
};