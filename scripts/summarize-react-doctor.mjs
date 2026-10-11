import { readFileSync, writeFileSync } from 'fs';

const r = JSON.parse(readFileSync('react-doctor-report.json', 'utf8'));
const diags =
  r.diagnostics?.length
    ? r.diagnostics
    : r.projects?.[0]?.diagnostics || [];

const bySev = {};
const byCat = {};
const byRule = {};
const byFile = {};
const errors = [];
const warningsTop = [];

for (const d of diags) {
  bySev[d.severity] = (bySev[d.severity] || 0) + 1;
  byCat[d.category || 'Unknown'] = (byCat[d.category || 'Unknown'] || 0) + 1;
  const rk = d.rule || 'unknown';
  byRule[rk] = (byRule[rk] || 0) + 1;
  byFile[d.filePath || 'unknown'] = (byFile[d.filePath || 'unknown'] || 0) + 1;
  if (d.severity === 'error') errors.push(d);
}

const ruleEntries = Object.entries(byRule).sort((a, b) => b[1] - a[1]);
const fileEntries = Object.entries(byFile).sort((a, b) => b[1] - a[1]);
const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);

// Collect top warnings (first occurrence of each rule)
const seenRules = new Set();
for (const d of diags) {
  if (d.severity !== 'warning') continue;
  if (seenRules.has(d.rule)) continue;
  seenRules.add(d.rule);
  warningsTop.push(d);
}

const lines = [];
lines.push('React Doctor Report Summary');
lines.push('===========================');
lines.push(`Version: ${r.version}`);
lines.push(`Framework: Next.js ${r.projects?.[0]?.project?.nextjsVersion || '?'} / React ${r.projects?.[0]?.project?.reactVersion || '?'}`);
lines.push(`Source files: ${r.projects?.[0]?.project?.sourceFileCount || '?'}`);
lines.push(`Elapsed: ${r.elapsedMilliseconds}ms`);
lines.push(`OK: ${r.ok}`);
if (r.error) lines.push(`Error field: ${JSON.stringify(r.error)}`);
lines.push('');
lines.push('Summary counts:');
lines.push(JSON.stringify(r.summary, null, 2));
lines.push('');
lines.push('By severity:');
lines.push(JSON.stringify(bySev, null, 2));
lines.push('');
lines.push('By category:');
for (const [k, v] of catEntries) lines.push(`  ${v}\t${k}`);
lines.push('');
lines.push('By rule:');
for (const [k, v] of ruleEntries) lines.push(`  ${v}\t${k}`);
lines.push('');
lines.push('By file:');
for (const [k, v] of fileEntries) lines.push(`  ${v}\t${k}`);
lines.push('');
lines.push('=== ERRORS (all) ===');
for (const e of errors) {
  lines.push(`[${e.category}] ${e.rule} @ ${e.filePath}:${e.line}`);
  lines.push(`  ${e.title}`);
  lines.push(`  ${e.message}`);
  if (e.help) lines.push(`  Help: ${e.help}`);
  lines.push('');
}
lines.push('=== WARNING RULE SAMPLES (one per rule) ===');
for (const w of warningsTop) {
  lines.push(`[${w.category}] ${w.rule} x${byRule[w.rule]} @ ${w.filePath}:${w.line}`);
  lines.push(`  ${w.title}`);
  lines.push(`  ${w.message}`);
  lines.push('');
}

const out = lines.join('\n');
writeFileSync('react-doctor-summary.txt', out, 'utf8');
console.log(out);
