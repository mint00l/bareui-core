# bareui-core

A minimal reactive UI library for lightweight apps, widgets, and experiments.

BareUI is designed to stay small, readable, and easy to reason about. It provides a few focused primitives for reactivity, templating, lifecycle hooks, and DOM mounting.

## API

### `reactive(object)`

Creates a reactive proxy.

When a property changes, any `effect()` or template binding that reads it will update automatically.

You can use `reactive()` in two common ways:

#### Globally scoped reactive state

```js
import { reactive, effect } from 'bareui-core';

const state = reactive({
  count: 0,
});

effect(() => {
  console.log('count changed:', state.count);
});

state.count++;
```

#### Component‑scoped reactive state

```js
import { component, html, reactive } from 'bareui-core';

const Counter = component(() => {
  const state = reactive({
    count: 0,
  });

  return html`
    <button @click=${() => state.count++}>
      Count: ${() => state.count}
    </button>
  `;
});
```

### `effect(fn)`
Runs a function and tracks the reactive values it reads.

When those values change, the function runs again.

Outside a component, the returned runner can be stopped manually with stop().

#### Manual effect with `stop()`

```js
import { effect, reactive } from 'bareui-core';

const state = reactive({
  count: 0,
});

const runner = effect(() => {
  console.log('count:', state.count);
});

state.count++;
runner.stop();
state.count++;
```

#### Automatic effect inside a component
If `effect()` is created while a component is rendering, it becomes part of that component’s scope and is cleaned up automatically when the component is unmounted.

```js
import { component, effect, html, reactive } from 'bareui-core';

const Counter = component(() => {
  const state = reactive({
    count: 0,
  });

  effect(() => {
    console.log('component count:', state.count);
  });

  return html`
    <button @click=${() => state.count++}>
      Count: ${() => state.count}
    </button>
  `;
});
```

### `html'...'`
Creates a template result using tagged template literals.

#### Use ${...} placeholders for dynamic content, attributes, and event handlers.

```js
import { html } from 'bareui-core';

const view = html`
  <div class="card">
    <h1>Hello</h1>
    <p>This is a BareUI template.</p>
  </div>
`;
```

#### Dynamic bindings
```js
import { html } from 'bareui-core';

const title = 'Hello';
const isActive = true;

const view = html`
  <div class=${isActive ? 'active' : 'idle'}>
    <h1>${title}</h1>
  </div>
`;
```

### `component(fn)`
Wraps a render function in a component scope.

Use it when you want lifecycle callbacks, scoped effects, and grouped cleanup.

```js
import { component, html, reactive } from 'bareui-core';

const App = component(() => {
  const state = reactive({
    name: 'BareUI',
  });

  return html`
    <h1>Hello ${() => state.name}</h1>
  `;
});
```
A component is especially useful when you want state, effects, and cleanup to belong to the same UI unit.

### `onMounted(fn)`
Registers a callback that runs after the component is mounted.

```js
import { component, html, onMounted } from 'bareui-core';

const App = component(() => {
  onMounted(() => {
    console.log('mounted');
  });

  return html`
    <div>Mounted component</div>
  `;
});
```

### `onUnmounted(fn)`
Registers a callback that runs when the component is disposed.

```js
import { component, html, onUnmounted } from 'bareui-core';

const App = component(() => {
  onUnmounted(() => {
    console.log('unmounted');
  });

  return html`
    <div>Cleanup example</div>
  `;
});
```

### `repeat(items, keyFn, renderItem)`
Renders a keyed list of items and keeps DOM updates efficient.

```js
import { component, html, reactive, repeat } from 'bareui-core';

const App = component(() => {
  const state = reactive({
    items: [
      { id: 1, label: 'Alpha' },
      { id: 2, label: 'Beta' },
    ],
  });

  return html`
    <ul>
      ${repeat(
        () => state.items,
        item => item.id,
        item => html`<li>${item.label}</li>`
      )}
    </ul>
  `;
});
```

### `mount(view, container)`
Mounts a template result or render function into a DOM element.

You can mount:

   * a TemplateResult

   * a render function that returns a renderable value

#### Mounting a component
```js
import { component, html, mount } from 'bareui-core';

const App = component(() => html`
  <div>Hello from BareUI</div>
`);

mount(App(), document.getElementById('app'));
```

#### Mounting a plain template
```js
import { html, mount } from 'bareui-core';

const view = html`
  <div>Plain template</div>
`;

mount(view, document.getElementById('app'));
```




### Notes
* bareui-core is designed to stay small and readable.
* It works best for lightweight apps, widgets, demos, and UI experiments.

### License
MIT