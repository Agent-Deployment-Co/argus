// Ambient declarations for files imported with Bun's `file` loader
// (`import path from "./asset" with { type: "file" }`). The import evaluates to a path string:
// the real source path under `bun run`, and an embedded `/$bunfs/…` path inside a
// `bun build --compile` executable. Reading that path with `node:fs` works in both modes, so these
// assets travel inside the compiled binary instead of having to sit beside it on disk.
declare module "*.woff2" {
  const path: string;
  export default path;
}

declare module "*.umd.min.js" {
  const path: string;
  export default path;
}
