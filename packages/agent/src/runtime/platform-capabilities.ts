/** Capability policy for Node running inside Android/Termux (Bionic, not glibc).
 * Pure helpers deliberately allow testing without pretending Windows is Android.
 */
export function isTermuxRuntime(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return platform === 'android' || !!env.TERMUX_VERSION ||
    (typeof env.PREFIX === 'string' && /\/data\/data\/[^/]*termux[^/]*\/files\/usr(?:\/|$)/.test(env.PREFIX));
}

/** Hide tools which require unbundled desktop binaries, a Docker daemon, or
 * a native library not distributed for the Android/Bionic ABI. Other tools
 * remain available only if their real runtime dependencies are installed.
 */
export const TERMUX_DISABLED_TOOLS = Object.freeze([
  'write_pdf', 'read_images',
  'docker_inventory', 'docker_inspect', 'sandbox_run',
  'ast_search', 'ast_rewrite',
] as const);
const unavailable = new Set<string>(TERMUX_DISABLED_TOOLS);
export function availableOnTermux(name: string): boolean { return !unavailable.has(name); }
export function platformCapabilities(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env) {
  const termux = isTermuxRuntime(platform, env);
  return {
    environment: termux ? 'termux-android' : platform,
    arch: process.arch,
    termux,
    disabledTools: termux ? [...TERMUX_DISABLED_TOOLS] : [],
    note: termux
      ? 'Android/Termux has different Bionic native binaries than GNU/Linux ARM64. Desktop/PDF rendering, native sharp preview, Docker and ast-grep are not advertised; other tools require their local dependencies. Pairing and core file/terminal tools still need an on-device smoke test.'
      : 'Runtime feature availability also depends on installed applications and permissions.',
  };
}
