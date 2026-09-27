/** Build flavor compiled into every main/preload/renderer bundle by electron-vite. */
export const BUILD_FLAVORS = ['debug', 'dev', 'shipping'] as const;
export type BuildFlavor = (typeof BUILD_FLAVORS)[number];

// Vite replaces this identifier with a string literal at build time. Tests and direct
// TypeScript execution do not pass through that transform, so they intentionally model the
// laptop/local default: debug. Runtime environment variables never participate in this value.
declare const __PARADIGMEVE_BUILD_FLAVOR__: BuildFlavor;
export const BUILD_FLAVOR: BuildFlavor =
  typeof __PARADIGMEVE_BUILD_FLAVOR__ === 'undefined' ? 'debug' : __PARADIGMEVE_BUILD_FLAVOR__;
