/**
 * Returns true when the value is a non-null object.
 */
export function isObject(value: unknown): value is object {
    return value !== null && typeof value === 'object';
}

/**
 * Runs callbacks from last to first, catching and logging individual errors
 * so one failing cleanup does not prevent the others from running.
 */
export function runCallbacks(callbacks: Array<() => void>): void {
    for (let i = callbacks.length - 1; i >= 0; i--) {
        try {
            callbacks[i]();
        } catch (err) {
            console.error(err);
        }
    }
}