/**
 * Extracts the namespace/package a source file declares, for languages where imports
 * reference a namespace rather than a file path. The result is matched against other
 * files' imports during edge resolution (see graphAlgorithms.resolveImports), so that
 * e.g. a C# file with `using Axon.Services;` links to every file that declares
 * `namespace Axon.Services`.
 */

interface ModulePattern {
  pattern: RegExp;
  group: number;
}

const patternsByExtension: Record<string, ModulePattern[]> = {
  // C#: block `namespace X.Y { }` and file-scoped `namespace X.Y;`
  '.cs': [{ pattern: /^\s*namespace\s+([\w.]+)/mu, group: 1 }],
  // Java / Kotlin / Scala / Groovy: `package x.y.z`
  '.java': [{ pattern: /^\s*package\s+([\w.]+)\s*;/mu, group: 1 }],
  '.kt': [{ pattern: /^\s*package\s+([\w.]+)/mu, group: 1 }],
  '.kts': [{ pattern: /^\s*package\s+([\w.]+)/mu, group: 1 }],
  '.scala': [{ pattern: /^\s*package\s+([\w.]+)/mu, group: 1 }],
  '.groovy': [{ pattern: /^\s*package\s+([\w.]+)/mu, group: 1 }],
  // PHP: `namespace App\Services;` (normalize backslashes to dots)
  '.php': [{ pattern: /^\s*namespace\s+([\w\\]+)\s*;/mu, group: 1 }],
  // Visual Basic: `Namespace X.Y`
  '.vb': [{ pattern: /^\s*Namespace\s+([\w.]+)/imu, group: 1 }],
};

/** Returns the declared namespace/package for `text`, normalized with dot separators. */
export function extractModuleDeclaration(text: string, ext: string): string | undefined {
  const patterns = patternsByExtension[ext];
  if (!patterns) return undefined;

  for (const { pattern, group } of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[group]?.trim();
    if (raw) {
      return normalizeModule(raw);
    }
  }
  return undefined;
}

/** Normalize a namespace to dot-separated form (PHP uses backslashes). */
export function normalizeModule(name: string): string {
  return name.replace(/\\/gu, '.').replace(/\.+$/u, '').trim();
}
