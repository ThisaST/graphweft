import { CodeGraphFile, CodeSymbol } from '../graph/graphTypes';
import { buildFileGraph, buildSymbolReferences, communityLabels, computeDegrees, symbolUsageCounts } from '../graph/graphAlgorithms';

export interface GraphReport {
  generatedAt: string;
  totalFiles: number;
  totalSymbols: number;
  totalEdges: number;
  godNodes: Array<{ path: string; totalDegree: number; inDegree: number; outDegree: number }>;
  hotSymbols: Array<{ symbolName: string; definedIn: string; referencedBy: number }>;
  orphanFiles: string[];
  largestCommunities: Array<{ id: number; size: number; sample: string[] }>;
  surprisingConnections: Array<{ from: string; to: string; reason: string }>;
  suggestedQuestions: string[];
}

export function buildGraphReport(files: CodeGraphFile[]): GraphReport {
  const graph = buildFileGraph(files);
  const degrees = computeDegrees(graph);
  const labels = communityLabels(graph);
  const totalEdges = Array.from(graph.adjacency.values()).reduce((sum, set) => sum + set.size, 0);

  const godNodes = degrees.slice(0, 10).filter((d) => d.totalDegree > 0);
  const orphans = degrees.filter((d) => d.totalDegree === 0).map((d) => d.path).slice(0, 50);
  const hotSymbols = symbolUsageCounts(buildSymbolReferences(files)).slice(0, 10);

  const groups = new Map<number, string[]>();
  for (const [node, label] of labels) {
    const arr = groups.get(label) ?? [];
    arr.push(node);
    groups.set(label, arr);
  }
  const largestCommunities = Array.from(groups.entries())
    .map(([id, members]) => ({ id, size: members.length, sample: members.slice(0, 5) }))
    .filter((c) => c.size > 1)
    .sort((a, b) => b.size - a.size)
    .slice(0, 6);

  const surprising = findSurprisingConnections(files, labels);
  const suggestedQuestions = suggestQuestions(files, godNodes.map((g) => g.path));

  return {
    generatedAt: new Date().toISOString(),
    totalFiles: files.length,
    totalSymbols: files.reduce((s, f) => s + f.symbols.length, 0),
    totalEdges,
    godNodes,
    hotSymbols,
    orphanFiles: orphans,
    largestCommunities,
    surprisingConnections: surprising,
    suggestedQuestions,
  };
}

export function renderGraphReportMarkdown(report: GraphReport): string {
  const lines: string[] = [];
  lines.push(`# CodeGraph Report`);
  lines.push(``);
  lines.push(`_Generated locally on ${report.generatedAt}. No data left your machine._`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(`- Files indexed: **${report.totalFiles}**`);
  lines.push(`- Symbols indexed: **${report.totalSymbols}**`);
  lines.push(`- Import edges: **${report.totalEdges}**`);
  lines.push(``);

  lines.push(`## God Nodes (most-connected files)`);
  if (report.godNodes.length === 0) {
    lines.push(`_No connected files detected — imports may not resolve for this workspace._`);
  } else {
    lines.push(`| File | Total | In | Out |`);
    lines.push(`| --- | ---: | ---: | ---: |`);
    for (const node of report.godNodes) {
      lines.push(`| \`${node.path}\` | ${node.totalDegree} | ${node.inDegree} | ${node.outDegree} |`);
    }
  }
  lines.push(``);

  if (report.hotSymbols.length > 0) {
    lines.push(`## Hot Symbols (most-imported symbols)`);
    lines.push(`| Symbol | Defined in | Imported by |`);
    lines.push(`| --- | --- | ---: |`);
    for (const symbol of report.hotSymbols) {
      lines.push(`| \`${symbol.symbolName}\` | \`${symbol.definedIn}\` | ${symbol.referencedBy} |`);
    }
    lines.push(``);
  }

  lines.push(`## Communities`);
  if (report.largestCommunities.length === 0) {
    lines.push(`_No clusters found._`);
  } else {
    for (const community of report.largestCommunities) {
      lines.push(`- **Cluster #${community.id}** (${community.size} files): ${community.sample.map((s) => `\`${s}\``).join(', ')}${community.size > community.sample.length ? ' …' : ''}`);
    }
  }
  lines.push(``);

  if (report.surprisingConnections.length > 0) {
    lines.push(`## Surprising Connections`);
    for (const conn of report.surprisingConnections) {
      lines.push(`- \`${conn.from}\` → \`${conn.to}\` — ${conn.reason}`);
    }
    lines.push(``);
  }

  if (report.orphanFiles.length > 0) {
    lines.push(`## Orphan Files (no resolved imports either direction)`);
    lines.push(report.orphanFiles.slice(0, 20).map((p) => `- \`${p}\``).join('\n'));
    if (report.orphanFiles.length > 20) {
      lines.push(`- … and ${report.orphanFiles.length - 20} more.`);
    }
    lines.push(``);
  }

  lines.push(`## Suggested Questions`);
  for (const q of report.suggestedQuestions) {
    lines.push(`- ${q}`);
  }
  lines.push(``);

  return lines.join('\n');
}

function findSurprisingConnections(files: CodeGraphFile[], labels: Map<string, number>): Array<{ from: string; to: string; reason: string }> {
  const surprises: Array<{ from: string; to: string; reason: string }> = [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  for (const file of files) {
    for (const importRef of file.imports) {
      if (!importRef.specifier.startsWith('.')) continue;
      const fromSeg = topLevelSegment(file.path);
      for (const candidate of byPath.values()) {
        if (candidate.path === file.path) continue;
        if (!importRef.specifier.includes(stripExtension(candidate.path.split('/').pop()!))) continue;
        const toSeg = topLevelSegment(candidate.path);
        if (fromSeg && toSeg && fromSeg !== toSeg) {
          const fromLabel = labels.get(file.path);
          const toLabel = labels.get(candidate.path);
          if (fromLabel !== undefined && toLabel !== undefined && fromLabel !== toLabel) {
            surprises.push({
              from: file.path,
              to: candidate.path,
              reason: `crosses top-level boundary (${fromSeg} → ${toSeg})`,
            });
          }
        }
      }
    }
    if (surprises.length >= 10) break;
  }

  return surprises.slice(0, 10);
}

function suggestQuestions(files: CodeGraphFile[], godPaths: string[]): string[] {
  const questions: string[] = [];
  for (const path of godPaths.slice(0, 3)) {
    questions.push(`@codegraph explain how \`${path}\` is used across the project`);
  }
  const testish = files.find((f) => /test|spec/u.test(f.path));
  if (testish) questions.push(`@codegraph add tests near \`${testish.path}\``);
  const controllerish = files.find((f) => f.symbols.some((s: CodeSymbol) => s.type === 'nestjsController' || /controller|router|handler/iu.test(s.name)));
  if (controllerish) questions.push(`@codegraph trace a request through \`${controllerish.path}\``);
  questions.push(`@codegraph review my current changes`);
  questions.push(`/path src/a.ts src/b.ts — find a connection between any two files`);
  return questions.slice(0, 6);
}

function topLevelSegment(filePath: string): string | undefined {
  const parts = filePath.split('/');
  if (parts[0] === 'src' && parts.length > 1) return parts[1];
  return parts[0];
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/u, '');
}
