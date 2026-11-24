// Bundles the engine into one ESM file shipped next to the bundled Node runtime.
import { build } from "esbuild";

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
  logLevel: "info",
});
