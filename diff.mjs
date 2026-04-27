#!/usr/bin/env node
/**
 * agentsnap-action diff runner.
 *
 * Walks AGENTSNAP_DIR for *.snap.json baselines. For each baseline, looks for
 * a sibling *.current.json (the output of the developer's record() call) and
 * runs diff() from @mukundakatta/agentsnap. Writes a JSON report and emits
 * GitHub Action outputs. Optionally overwrites baselines when AGENTSNAP_UPDATE=1.
 */
import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { diff, formatDiff } from '@mukundakatta/agentsnap';

const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
const dir = process.env.AGENTSNAP_DIR || 'tests/__agentsnap__';
const updateMode = process.env.AGENTSNAP_UPDATE === '1';
const failOn = (process.env.AGENTSNAP_FAIL_ON || 'OUTPUT_DRIFT,TOOLS_CHANGED,REGRESSION')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const reportPath = process.env.AGENTSNAP_REPORT_PATH || 'agentsnap-report.json';

const absDir = join(cwd, dir);

function setOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  return writeFile(out, `${name}=${value}\n`, { flag: 'a' });
}

async function* walkSnapshots(root) {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.snap.json')) {
        yield abs;
      }
    }
  }
}

async function main() {
  if (!existsSync(absDir)) {
    console.log(`[agentsnap] snapshots dir does not exist: ${dir}`);
    await mkdir(absDir, { recursive: true });
  }

  const results = [];
  let total = 0;
  let driftCount = 0;
  let createdCount = 0;
  let updatedCount = 0;

  for await (const baselinePath of walkSnapshots(absDir)) {
    total += 1;
    const rel = relative(cwd, baselinePath);
    const currentPath = baselinePath.replace(/\.snap\.json$/, '.current.json');

    if (!existsSync(currentPath)) {
      // No current run produced — record-only mode hasn't run yet. Skip but report.
      results.push({
        file: rel,
        status: 'NO_CURRENT',
        message: `expected sibling ${basename(currentPath)} (produced by record()) but it was not found`,
      });
      console.log(`::warning file=${rel}::no current trace at ${basename(currentPath)} — did the test runner produce one?`);
      continue;
    }

    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const current = JSON.parse(await readFile(currentPath, 'utf8'));

    if (updateMode) {
      // Overwrite baseline with current; skip diff.
      await copyFile(currentPath, baselinePath);
      updatedCount += 1;
      results.push({ file: rel, status: 'UPDATED' });
      console.log(`[agentsnap] updated ${rel}`);
      continue;
    }

    const result = diff(baseline, current);
    const entry = {
      file: rel,
      status: result.status,
      changes: result.changes,
    };
    results.push(entry);

    if (result.status === 'PASSED') {
      console.log(`[agentsnap] PASSED ${rel}`);
      continue;
    }

    driftCount += 1;
    const formatted = formatDiff(result, rel);
    // Output the diff as a workflow group so it folds neatly in the UI.
    console.log(`::group::agentsnap drift: ${rel}`);
    console.log(formatted);
    console.log('::endgroup::');
    if (failOn.includes(result.status)) {
      console.log(`::error file=${rel}::agentsnap ${result.status}`);
    } else {
      console.log(`::warning file=${rel}::agentsnap ${result.status} (not in fail-on)`);
    }
  }

  // First-run helper: if there's a *.current.json without a baseline, write
  // the baseline so the next run has something to diff against.
  if (existsSync(absDir)) {
    const stack = [absDir];
    while (stack.length) {
      const cur = stack.pop();
      const entries = await readdir(cur, { withFileTypes: true });
      for (const entry of entries) {
        const abs = join(cur, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.current.json')) {
          const baselinePath = abs.replace(/\.current\.json$/, '.snap.json');
          if (!existsSync(baselinePath)) {
            await mkdir(dirname(baselinePath), { recursive: true });
            await copyFile(abs, baselinePath);
            createdCount += 1;
            total += 1;
            const rel = relative(cwd, baselinePath);
            results.push({ file: rel, status: 'CREATED' });
            console.log(`[agentsnap] created baseline ${rel}`);
          }
        }
      }
    }
  }

  const report = {
    summary: {
      total_snapshots: total,
      drift: driftCount,
      created: createdCount,
      updated: updatedCount,
      fail_on: failOn,
      update_mode: updateMode,
    },
    results,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  await setOutput('total-snapshots', total);
  await setOutput('drift-count', driftCount);
  await setOutput('report-path', reportPath);

  console.log(
    `[agentsnap] ${total} snapshots | ${driftCount} drift | ${createdCount} created | ${updatedCount} updated | report: ${reportPath}`,
  );

  // Decide exit code.
  if (updateMode) return; // never fail in update mode
  const failingResults = results.filter((r) => failOn.includes(r.status));
  if (failingResults.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[agentsnap] fatal: ${err.stack || err.message}`);
  process.exit(2);
});
