// Browser APIs HeroUI and React Aria use that jsdom lacks. Import this from a test that renders tabs, drawers or
// the app layout; it only fills what is missing.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

Element.prototype.getAnimations ??= () => [];

// React Flow reads the viewport transform through DOMMatrixReadOnly.
globalThis.DOMMatrixReadOnly ??= class {
  m22 = 1;
  constructor(transform?: string) {
    const scale = /scale\(([\d.]+)\)/.exec(transform ?? "");
    if (scale) this.m22 = Number(scale[1]);
  }
} as unknown as typeof DOMMatrixReadOnly;
