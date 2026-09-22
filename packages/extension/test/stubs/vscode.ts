/**
 * Just enough `vscode` to import an extension module under vitest.
 *
 * Most tests in here read source as text precisely to avoid this import, which
 * works until the thing worth testing is a pure function that happens to live
 * beside a status bar. Only the members touched at module load or by the pure
 * paths are stubbed — anything else is deliberately absent, so a test that
 * wanders into real UI code fails loudly instead of passing against a mock.
 */

export class EventEmitter<T> {
  private readonly listeners: Array<(e: T) => void> = [];
  get event() {
    return (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { /* no-op */ } };
    };
  }
  fire(e: T): void {
    for (const l of this.listeners) { l(e); }
  }
  dispose(): void { /* no-op */ }
}

export class MarkdownString {
  isTrusted = false;
  supportThemeIcons = false;
  constructor(public value = '') {}
  appendMarkdown(v: string): this { this.value += v; return this; }
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}
