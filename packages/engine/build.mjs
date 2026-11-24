// Bundles the engine into one ESM file shipped next to the bundled Node runtime.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

// The app version (apps/desktop/package.json) is the single source of truth for every component.
const { version } = JSON.parse(readFileSync(new URL("../../apps/desktop/package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/engine.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: "linked",
  legalComments: "external",
  // Some dependencies are CommonJS and call require(); give the ESM bundle a real one.
  banner: { js: "import { createRequire as __hubCreateRequire } from 'node:module'; const require = __hubCreateRequire(import.meta.url);" },
  define: { __HUB_VERSION__: JSON.stringify(version) },
  logLevel: "info",
});
