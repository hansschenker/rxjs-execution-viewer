// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

/** Exercises the real browser controller and real RxJS recordings together. */
it('loads, steps, plays, inspects, changes scenarios, imports, and exports through the interface', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const createObjectURL = vi.fn(() => 'blob:execution-test');
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  await import('../src/main');

  function element<T extends Element>(selector: string): T {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Missing UI element ${selector}`);
    return found;
  }

  function click(selector: string): void {
    element<HTMLElement>(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  expect(element('#trace-title').textContent).toBe('Only the latest');
  expect(document.querySelectorAll('#diagram svg')).toHaveLength(1);
  expect(document.querySelectorAll('#diagram [data-node-id]').length).toBeGreaterThanOrEqual(4);
  expect(element('#duration').textContent).toBe('220 ms');
  const count = Number(element('#event-count').textContent);
  expect(count).toBeGreaterThan(10);

  click('#first');
  expect(element('#progress-summary').textContent).toContain('Before execution');
  expect(element<HTMLButtonElement>('#previous').disabled).toBe(true);
  click('#next');
  expect(element('#progress-summary').textContent).toContain('Step 1 /');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  expect(element('#progress-summary').textContent).toContain('Step 2 /');
  const unrelated = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
  document.dispatchEvent(unrelated);
  expect(unrelated.defaultPrevented).toBe(false);
  const nativeSelectKey = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  element('#scenario').dispatchEvent(nativeSelectKey);
  expect(nativeSelectKey.defaultPrevented).toBe(false);

  click('#last');
  click('#diagram [data-node-id="debounce"]');
  expect(element('#inspector h2').textContent).toBe('debounceTime(40)');
  expect(element('#inspector').textContent).toContain('Mealy model');
  click('#event-list button[data-seq="3"]');
  expect(element('#progress-summary').textContent).toContain('Step 4 /');

  vi.useFakeTimers();
  click('#first');
  click('#play');
  expect(element('#play').getAttribute('aria-pressed')).toBe('true');
  vi.advanceTimersByTime(1_000);
  expect(Number(element<HTMLInputElement>('#seek').value)).toBeGreaterThan(0);
  click('#play');
  const paused = element<HTMLInputElement>('#seek').value;
  vi.advanceTimersByTime(1_000);
  expect(element<HTMLInputElement>('#seek').value).toBe(paused);
  vi.useRealTimers();

  const select = element<HTMLSelectElement>('#scenario');
  select.value = 'sync-take';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  expect(element('#duration').textContent).toBe('0 ms');
  select.value = 'shared-connection';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  expect(element('#duration').textContent).toBe('130 ms');
  expect(element('#status').textContent).toContain('Loaded');

  click('#export-json');
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(anchorClick).toHaveBeenCalledOnce();
  click('#export-snapshot');
  click('#export-player');
  expect(createObjectURL).toHaveBeenCalledTimes(3);
  expect(element('#status').textContent).toContain('Portable SVG player exported');

  const input = element<HTMLInputElement>('#import-file');
  const badFile = new File(['not JSON'], 'invalid.json', { type: 'application/json' });
  Object.defineProperty(badFile, 'text', { value: async () => 'not JSON' });
  Object.defineProperty(input, 'files', { configurable: true, value: [badFile] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(element('#status').textContent).toContain('Invalid trace JSON'));
  expect(element('#duration').textContent).toBe('130 ms');

  const { scenarios } = await import('../src/scenarios');
  const imported = scenarios[0]!.build();
  imported.title = '<img src=x onerror=alert(1)> Imported';
  const json = JSON.stringify(imported);
  const file = new File([json], 'sample.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => json });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(element('#status').textContent).toContain('Imported'));
  expect(element('#trace-title').textContent).toBe(imported.title);
  expect(document.querySelectorAll('img')).toHaveLength(0);
  expect(element('#duration').textContent).toBe('220 ms');
  expect(select.value).toBe('imported');

  anchorClick.mockRestore();
  vi.unstubAllGlobals();
});
