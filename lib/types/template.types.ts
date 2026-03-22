/**
 * A function or plain value source used by template bindings.
 */
export type Source<T> = T | (() => T);

/**
 * A value that can be rendered into the DOM.
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