// Explicit-resource-management symbols may be missing on older engines
// (notably older mobile WebKit); deltic's runtime and the surface classes
// use them in computed class keys, which throw at module evaluation if the
// symbol is undefined. This module must be imported before anything else.
(Symbol as unknown as { dispose: symbol }).dispose ??= Symbol.for(
  "Symbol.dispose",
);
(Symbol as unknown as { asyncDispose: symbol }).asyncDispose ??= Symbol.for(
  "Symbol.asyncDispose",
);
export {};
