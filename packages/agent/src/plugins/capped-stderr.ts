/** Rotating, bounded per-plugin stderr. Never holds the full log in memory. */
import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
const MAX_LOG_BYTES = 512 * 1024;
const RETAIN_BYTES = 192 * 1024;

/** Each plugin's stderr file is capped; the process remains responsive even
 * when a plugin emits substantial diagnostics. File mode 0600 protects logs
 * on platforms with POSIX permissions. */
export function cappedPluginStderr(logPath: string): Writable {
  let size = 0;
  let initialized = false;
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk:Buffer|string,_encoding,callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      void (async () => {
        if (!initialized) {
          initialized = true;
          try { size = (await fs.stat(logPath)).size; }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        }
        if (size + bytes.length <= MAX_LOG_BYTES) {
          await fs.appendFile(logPath,bytes,{mode:0o600});
          size += bytes.length;
          return;
        }
        // Keep recent diagnostics. Cap memory even if an individual chunk is
        // enormous or a previous agent version wrote an unbounded log.
        let previous = Buffer.alloc(0);
        try {
          const handle = await fs.open(logPath,'r');
          try {
            const st = await handle.stat();
            const n = Math.min(st.size,RETAIN_BYTES);
            previous=Buffer.alloc(n);
            if (n) await handle.read(previous,0,n,st.size-n);
          } finally { await handle.close(); }
        } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        const next=Buffer.concat([previous,bytes.subarray(-MAX_LOG_BYTES)]);
        const clipped=next.subarray(Math.max(0,next.length-MAX_LOG_BYTES));
        await fs.writeFile(logPath,clipped,{mode:0o600});
        size=clipped.length;
      })().then(()=>callback(),()=>callback()); // a logging fault must not kill the plugin
    },
  });
  return sink;
}
