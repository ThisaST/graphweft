const typescriptExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const genericExtensions = new Set([
  '.py', '.go', '.rs', '.rb', '.java', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.psd1',
  '.yaml', '.yml', '.json', '.toml', '.ini', '.env',
  '.tf', '.hcl', '.bicep',
  '.md', '.mdx',
  '.dockerfile', '.containerfile',
  '.proto',
  '.lua', '.php', '.kt', '.swift', '.scala', '.clj',
]);

// Directories that hold dependencies or build output — never source we want in the graph.
// Kept cross-language: each entry is a strong, conventional artifact/dependency dir name.
const excludedSegments = new Set([
  // JS/TS ecosystem
  'node_modules', 'bower_components',
  'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.angular', '.parcel-cache', '.turbo', '.cache',
  '.vercel', '.netlify', '.docusaurus', '.expo', 'storybook-static',
  // .NET / Java / Kotlin / Rust / Scala
  'obj', 'bin', 'target', '.gradle',
  '_framework', // Blazor/WASM runtime assets (dotnet.*.js, blazor.*.js)
  // Go / PHP / Ruby dependencies
  'vendor', '.bundle',
  // Python
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.eggs',
  // Swift / iOS
  'Pods', 'DerivedData', '.build', 'Carthage',
  // Dart / Flutter
  '.dart_tool',
  // Elixir / Erlang / OCaml
  '_build', 'deps',
  // Haskell
  'dist-newstyle', '.stack-work',
  // Clojure
  '.cpcache',
  // C / C++ (CMake)
  'cmake-build-debug', 'cmake-build-release', 'CMakeFiles',
  // Infra
  '.terraform',
  // VCS / IDE
  '.git', '.svn', '.hg', '.idea', '.vs',
]);

/**
 * Filename patterns for generated / compiled artifacts that slip past directory filters
 * (e.g. a `*.GlobalUsings.g.cs` emitted into the project root, or a checked-in `*.min.js`).
 */
const generatedFilePatterns: RegExp[] = [
  // Web bundles / maps
  /\.min\.(js|css)$/u,
  /\.bundle\.js$/u,
  /\.map$/u,
  // .NET source generators & runtime assets
  /\.g\.cs$/u, // *.GlobalUsings.g.cs, *.AssemblyInfo.g.cs, etc.
  /\.g\.i\.cs$/u,
  /\.designer\.cs$/u,
  /\.assemblyinfo\.cs$/u,
  /\.assemblyattributes\.cs$/u,
  /(^|\/)dotnet(\.[\w.-]+)?\.js$/u, // dotnet.js, dotnet.runtime.*.js, dotnet.native.*.js
  /(^|\/)blazor\.[\w.-]+\.js$/u, // blazor.webassembly.js, blazor.web.js
  // Protobuf / gRPC codegen (Go, Python, C++, JS)
  /\.pb\.go$/u,
  /_pb2(_grpc)?\.py$/u,
  /\.pb\.(cc|h)$/u,
  /\.pb\.js$/u,
  // Common "*.generated.*" convention across languages
  /\.generated\.(cs|ts|js|go|java|kt)$/u,
  // Dependency lockfiles that would otherwise match our json/yaml/toml extensions
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/u,
  /(^|\/)pnpm-lock\.yaml$/u,
];

export const sourceGlob = '**/*.{ts,tsx,js,jsx}';
export const genericSourceGlob =
  '**/*.{py,go,rs,rb,java,cs,cpp,c,h,hpp,sh,bash,zsh,ps1,psm1,psd1,yaml,yml,toml,ini,env,tf,hcl,bicep,md,mdx,dockerfile,containerfile,proto,lua,php,kt,swift,scala,clj}';
export const excludeGlob =
  '**/{node_modules,bower_components,dist,build,out,coverage,.next,.nuxt,.svelte-kit,.angular,.parcel-cache,.turbo,.cache,.vercel,.netlify,.docusaurus,.expo,storybook-static,obj,bin,target,.gradle,_framework,vendor,.bundle,__pycache__,.venv,venv,.tox,.mypy_cache,.pytest_cache,.eggs,Pods,DerivedData,.build,Carthage,.dart_tool,_build,deps,dist-newstyle,.stack-work,.cpcache,cmake-build-debug,cmake-build-release,CMakeFiles,.terraform,.git,.svn,.hg,.idea,.vs}/**';

function normalize(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/** True when a directory name is a dependency/build dir we should not descend into. */
export function isExcludedDirSegment(name: string): boolean {
  return excludedSegments.has(name);
}

/** True for generated/compiled output we should never index, regardless of directory. */
export function isGeneratedArtifact(filePath: string): boolean {
  const normalized = normalize(filePath).toLowerCase();
  return generatedFilePatterns.some((pattern) => pattern.test(normalized));
}

export function isSupportedSourcePath(filePath: string): boolean {
  const normalized = normalize(filePath);
  const segments = normalized.split('/');

  if (segments.some((segment) => excludedSegments.has(segment))) {
    return false;
  }

  if (isGeneratedArtifact(normalized)) {
    return false;
  }

  const ext = normalized.includes('.') ? `.${normalized.split('.').pop()!.toLowerCase()}` : '';
  return typescriptExtensions.has(ext) || genericExtensions.has(ext);
}

export function isTypescriptSourcePath(filePath: string): boolean {
  const normalized = normalize(filePath);
  const ext = normalized.includes('.') ? `.${normalized.split('.').pop()!.toLowerCase()}` : '';
  return typescriptExtensions.has(ext);
}

/** Accepts anything with a `scheme`/`fsPath` (e.g. a `vscode.Uri`) — kept structural so this module stays vscode-free. */
export function isSupportedSourceUri(uri: { scheme: string; fsPath: string }): boolean {
  return uri.scheme === 'file' && isSupportedSourcePath(uri.fsPath);
}
