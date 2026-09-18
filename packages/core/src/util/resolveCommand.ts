/**
 * Turn a bare CLI name (`claude`, `codex`) into something `spawn`/`execFile`
 * can actually start on Windows.
 *
 * Without a shell, Node only launches real executables. An npm-installed CLI on
 * Windows is a `claude.cmd` shim, so `execFile('claude')` fails with ENOENT even
 * though `claude` works in every terminal — and since the CVE-2024-27980
 * hardening Node refuses to spawn a `.cmd` directly at all. Going through
 * `cmd.exe` instead would mean re-quoting every argument for cmd's parser,
 * which multi-line prompts and skills do not survive.
 *
 * So we resolve the shim to what it runs: npm's shims are generated from a
 * fixed template that either execs a native binary
 * (`"%dp0%\node_modules\…\claude.exe" %*`) or runs a script under node
 * (`"%_prog%" "%dp0%\node_modules\…\cli.js" %*`). Both are read straight out of
 * the file. Anything else falls back to `cmd.exe /d /c <shim>`, which is fine
 * for the simple argv the fallback callers pass.
 *
 * Off Windows this is the identity: `{ command: bin, args: [] }`.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ResolvedCommand {
  /** Executable to spawn. */
  command: string;
  /** Arguments that must precede the caller's own. */
  args: string[];
}

export interface ResolveCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const cache = new Map<string, ResolvedCommand>();

export function resolveCommand(bin: string, opts: ResolveCommandOptions = {}): ResolvedCommand {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') { return { command: bin, args: [] }; }
  // An explicit path or an .exe name is already spawnable.
  if (/[\\/]/.test(bin) || /\.(exe|com)$/i.test(bin)) { return { command: bin, args: [] }; }

  const env = opts.env ?? process.env;
  const pathVar = env.PATH ?? env.Path ?? '';
  const key = `${bin}\0${pathVar}`;
  const hit = cache.get(key);
  if (hit) { return hit; }

  const resolved = resolveOnPath(bin, pathVar, env) ?? { command: bin, args: [] };
  cache.set(key, resolved);
  return resolved;
}

/** Drop memoised lookups (tests, or after the user installs a CLI). */
export function clearResolveCommandCache(): void {
  cache.clear();
}

function resolveOnPath(bin: string, pathVar: string, env: NodeJS.ProcessEnv): ResolvedCommand | null {
  const exts = ['.exe', '.com', '.cmd', '.bat'];
  for (const dir of pathVar.split(';').filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir.replace(/^"|"$/g, ''), bin + ext);
      if (!isFile(full)) { continue; }
      if (ext === '.exe' || ext === '.com') { return { command: full, args: [] }; }
      return fromShim(full) ?? {
        command: env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/c', full],
      };
    }
  }
  return null;
}

/** Read the target out of an npm-generated `.cmd` shim. */
export function fromShim(shimPath: string): ResolvedCommand | null {
  let body: string;
  try {
    body = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(shimPath);
  const expand = (p: string) => path.normalize(p.replace(/%~?dp0%?\\?/gi, `${dir}\\`));

  // Script under node: `"%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*`
  const script = /"%_prog%"\s+"([^"]+)"\s+%\*/i.exec(body);
  if (script) {
    const localNode = path.join(dir, 'node.exe');
    return { command: isFile(localNode) ? localNode : 'node', args: [expand(script[1])] };
  }
  // Native binary: `"%dp0%\node_modules\pkg\bin\claude.exe"   %*`
  const exe = /"([^"]*%~?dp0%?[^"]*\.exe)"\s+%\*/i.exec(body);
  if (exe) {
    const target = expand(exe[1]);
    return isFile(target) ? { command: target, args: [] } : null;
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
