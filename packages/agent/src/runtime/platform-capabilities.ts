/** Capability policy for Node running inside Android/Termux (Bionic, not glibc).
 * Pure helpers (platform/env are parameters) so tests can simulate Termux without Android.
 */
export function isTermuxRuntime(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return platform === 'android' || !!env.TERMUX_VERSION ||
    (typeof env.PREFIX === 'string' && /\/data\/data\/[^/]*termux[^/]*\/files\/usr(?:\/|$)/.test(env.PREFIX));
}

/** Tools that need unbundled desktop binaries, a Docker daemon, or a native library
 * not distributed for Android/Bionic. Hidden from the catalogue and refused when called.
 * NOTE: names are matched purely by string; listing a tool that is not registered in
 * this build (e.g. docker_*, sandbox_run, or tools ported by other branches) is harmless.
 */
export const TERMUX_DISABLED_TOOLS = Object.freeze([
  'write_pdf', 'read_images',
  'docker_inventory', 'docker_inspect', 'sandbox_run',
  'ast_search', 'ast_rewrite',
] as const);
const unavailable = new Set<string>(TERMUX_DISABLED_TOOLS);
export function availableOnTermux(name: string): boolean { return !unavailable.has(name); }

/** Platform string reported to the relay: 'android' on Termux, else Node's process.platform. */
export function reportedPlatform(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  return isTermuxRuntime(platform, env) ? 'android' : platform;
}

export function platformCapabilities(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env) {
  const termux = isTermuxRuntime(platform, env);
  return {
    environment: termux ? 'termux-android' : platform,
    arch: process.arch,
    termux,
    disabledTools: termux ? [...TERMUX_DISABLED_TOOLS] : [],
    note: termux
      ? 'Android/Termux has different Bionic native binaries than GNU/Linux ARM64. PDF rendering, native image previews, Docker and ast-grep are not advertised; other tools require their local dependencies.'
      : 'Runtime feature availability also depends on installed applications and permissions.',
  };
}
