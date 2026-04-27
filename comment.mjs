#!/usr/bin/env node
/**
 * Post a PR comment summarising agentsnap drift. Reads the JSON report
 * written by diff.mjs and shells out to `gh pr comment`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const reportPath = process.env.REPORT_PATH || 'agentsnap-report.json';
const prNumber = process.env.PR_NUMBER;
if (!prNumber) {
  console.log('[agentsnap-comment] no PR_NUMBER, skipping comment');
  process.exit(0);
}

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const drifted = (report.results || []).filter(
  (r) => r.status !== 'PASSED' && r.status !== 'CREATED' && r.status !== 'UPDATED',
);
if (drifted.length === 0) {
  console.log('[agentsnap-comment] no drift, nothing to comment');
  process.exit(0);
}

const lines = [];
lines.push('## agentsnap drift report');
lines.push('');
lines.push(`**${drifted.length}** of ${report.summary.total_snapshots} snapshot(s) drifted.`);
lines.push('');
for (const r of drifted) {
  lines.push(`### \`${r.file}\` — ${r.status}`);
  if (r.changes && r.changes.length > 0) {
    lines.push('');
    lines.push('| Path | Before | After |');
    lines.push('|---|---|---|');
    for (const ch of r.changes.slice(0, 20)) {
      const fmt = (v) => '`' + JSON.stringify(v).replace(/\|/g, '\\|').slice(0, 80) + '`';
      lines.push(`| \`${ch.path}\` | ${fmt(ch.from)} | ${fmt(ch.to)} |`);
    }
    if (r.changes.length > 20) {
      lines.push(`| _… ${r.changes.length - 20} more_ | | |`);
    }
  }
  lines.push('');
}
lines.push('---');
lines.push('To accept the new traces as the new baseline, re-run with `update-snapshots: true`.');

const body = lines.join('\n');
const tmpFile = '/tmp/agentsnap-comment.md';
await writeFile(tmpFile, body, 'utf8');

const r = spawnSync('gh', ['pr', 'comment', prNumber, '-F', tmpFile], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
