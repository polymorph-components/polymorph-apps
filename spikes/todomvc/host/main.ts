// Single bundle entry: the polyfill must evaluate before any deltic
// module (computed [Symbol.dispose] class keys), hence first import.

import "./polyfill.ts";
import { runDemo } from "./demo.ts";
import { runHarness } from "./harness.ts";
import { runBench } from "./bench.ts";

switch (document.body.dataset.page) {
  case "harness":
    runHarness();
    break;
  case "bench":
    runBench();
    break;
  default:
    runDemo();
}
