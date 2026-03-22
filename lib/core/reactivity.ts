import type { EffectOwner, EffectRunner } from '../types/reactivity.types';
import { isObject } from '../utils';

const subs = new WeakMap<object, Map<PropertyKey, Set<EffectRunner>>>();

/**
 * Cache raw object -> proxy.
 * Also keep proxy -> raw so reactive(proxy) can return the same proxy instead of double-wrapping.
 */
const rawToProxy = new WeakMap<object, object>();
const proxyToRaw = new WeakMap<object, object>();

let activeEffect: EffectRunner | null = null;
const effectStack: EffectRunner[] = [];
const effectOwnerStack: EffectOwner[] = [];

/**
 * Queue of effects scheduled to run in the next microtask flush.
 * A Set is used so the same effect can be triggered many times in one tick
 * without being executed more than once.
 */
const pendingEffects = new Set<EffectRunner>();

/**
 * True while a microtask has already been scheduled for pending effects.
 */
let flushScheduled = false;

/**
 * True while the effect queue is actively being flushed.
 * This prevents nested flushes from overlapping and keeps the scheduler stable
 * when effects trigger other effects while running.
 */
let isFlushing = false;

/**
 * Removes the runner from all dependency sets it has subscribed to.
 */
function cleanupEffect(runner: EffectRunner): void {
    for (const dep of runner.deps) {
        dep.delete(runner);
    }
    runner.deps.clear();
}

/**
 * Returns the current effect owner, if any.
 */
function getCurrentEffectOwner(): EffectOwner | null {
    return effectOwnerStack[effectOwnerStack.length - 1] ?? null;
}

/**
 * Pushes an effect owner onto the active ownership stack.
 */
export function pushEffectOwner(owner: EffectOwner): void {
    effectOwnerStack.push(owner);
}

/**
 * Pops the current effect owner from the active ownership stack.
 */
export function popEffectOwner(): void {
    effectOwnerStack.pop();
}

/**
 * Records that the active effect depends on target[key].
 */
function track(target: object, key: PropertyKey): void {
    if (!activeEffect) return;

    let depsMap = subs.get(target);
    if (!depsMap) {
        depsMap = new Map();
        subs.set(target, depsMap);
    }

    let dep = depsMap.get(key);
    if (!dep) {
        dep = new Set();
        depsMap.set(key, dep);
    }

    if (!dep.has(activeEffect)) {
        dep.add(activeEffect);
        activeEffect.deps.add(dep);
    }
}

/**
 * Adds an effect runner to the pending queue and ensures a microtask flush is
 * scheduled.
 *
 * The same runner can be triggered many times in a single turn of the event
 * loop, but it will only be executed once per flush because the queue is a Set.
 */
function queueEffect(runner: EffectRunner): void {
    if (runner.stopped) return;

    pendingEffects.add(runner);

    if (flushScheduled) return;

    flushScheduled = true;
    queueMicrotask(flushEffects);
}

/**
 * Flushes all queued effects in microtask order.
 *
 * If an effect causes more reactive writes while the queue is being flushed,
 * those newly scheduled effects are also processed before the flush finishes.
 */
function flushEffects(): void {
    if (isFlushing) return;

    flushScheduled = false;
    isFlushing = true;

    try {
        while (pendingEffects.size > 0) {
            const effects = Array.from(pendingEffects);
            pendingEffects.clear();

            for (const runner of effects) {
                if (!runner.stopped) {
                    runner();
                }
            }
        }
    } finally {
        isFlushing = false;
    }
}

/**
 * Triggers every effect subscribed to target[key].
 *
 * Instead of running effects immediately, they are queued and flushed once in
 * a microtask. This batches multiple writes into a single update pass.
 */
function trigger(target: object, key: PropertyKey): void {
    const depsMap = subs.get(target);
    if (!depsMap) return;

    const dep = depsMap.get(key);
    if (!dep) return;

    // Snapshot first so effects can mutate their own dependencies safely.
    const effects = new Set(dep);
    effects.forEach(runner => {
        queueEffect(runner);
    });
}

/**
 * Creates a reactive proxy for an object.
 * Nested objects are wrapped lazily on access.
 */
export function reactive<T extends object>(target: T): T {
    if (!isObject(target)) return target;

    const existingProxy = rawToProxy.get(target);
    if (existingProxy) return existingProxy as T;

    // If someone passes an already-reactive proxy back into reactive(),
    // return it as-is instead of proxying it again.
    if (proxyToRaw.has(target)) {
        return target;
    }

    const proxy = new Proxy(target, {
        get(t, key, receiver) {
            if (key === '__isReactive') return true;

            const value = Reflect.get(t, key, receiver);
            track(t, key);

            return isObject(value) ? reactive(value) : value;
        },

        set(t, key, value, receiver) {
            const oldValue = Reflect.get(t, key, receiver);
            const result = Reflect.set(t, key, value, receiver);

            if (!Object.is(oldValue, value)) {
                trigger(t, key);
            }

            return result;
        },

        deleteProperty(t, key) {
            const hadKey = Object.prototype.hasOwnProperty.call(t, key);
            const result = Reflect.deleteProperty(t, key);

            if (hadKey && result) {
                trigger(t, key);
            }

            return result;
        },
    });

    rawToProxy.set(target, proxy);
    proxyToRaw.set(proxy, target);

    return proxy as T;
}

/**
 * Creates a reactive effect and runs it immediately.
 * The returned runner can be called again or stopped manually.
 */
export function effect(fn: () => unknown): EffectRunner {
    const owner = getCurrentEffectOwner();

    const runner: EffectRunner = function () {
        if (runner.stopped) return;

        cleanupEffect(runner);

        try {
            effectStack.push(runner);
            activeEffect = runner;

            if (runner.owner) {
                effectOwnerStack.push(runner.owner);
            }

            return fn();
        } finally {
            if (runner.owner) {
                effectOwnerStack.pop();
            }

            effectStack.pop();
            activeEffect = effectStack[effectStack.length - 1] ?? null;
        }
    } as EffectRunner;

    runner.deps = new Set();
    runner.stopped = false;
    runner.owner = owner ?? null;

    runner.stop = () => {
        if (runner.stopped) return;

        runner.stopped = true;
        cleanupEffect(runner);
        pendingEffects.delete(runner);

        if (runner.owner) {
            runner.owner.effects.delete(runner);
        }
    };

    if (runner.owner) {
        runner.owner.effects.add(runner);
    }

    runner();
    return runner;
}