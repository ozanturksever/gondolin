import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  noExternal: [/^(?!node-pty|@fatagnus\/dink-sdk)/],
  banner: { js: "#!/usr/bin/env node" },
});
