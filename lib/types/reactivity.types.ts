/**
 * A reactive effect runner function.
 * It tracks its dependency sets so it can clean itself up when stopped.
 */
export interface EffectRunner {
    (): unknown;
    deps: Set<Set<EffectRunner>>;
    stopped: boolean;
    owner: EffectOwner | null;
    stop: () => void;
}

/**
 * A logical ownership scope for effects and lifecycle callbacks.
 * Components create one of these so nested reactive effects can be disposed together.
 */
export interface EffectOwner {
    effects: Set<EffectRunner>;
    cleanups: Array<() => void>;
    mounts: Array<() => void>;
    disposed: boolean;
}