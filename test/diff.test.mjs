/**
 * End-to-end tests for the diff.mjs runner.
 *
 * diff.mjs is invoked by action.yml as a standalone Node process, so the tests
 * exercise it the same way: spawn it with the GitHub-Action env vars set, point
 * it at an isolated temp workspace, and assert on its exit code, the
 * GITHUB_OUTPUT key/value pairs it writes, and the JSON report it produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const diffRunner = join(__dirname, '..', 'diff.mjs');

const PASSING_BASELINE = {
  version: 1,
  model: 'claude-sonnet-4-6',
  input: 'find me coffee shops',
  output: 'Found 3 coffee shops near you.',
  tools: [
    {
      name: 'search',
      args: { query: 'coffee shops', limit: 10 },
      result_hash: 'sha256:' + 'a'.repeat(64),
    },
  ],
  error: null,
  fingerprint: { node: 'v20.0.0', agentsnap: '0.1.0' },
};

/**
 * Create a throwaway workspace with a tests/__agentsnap__ snapshots dir.
 * Returns { workspace, snapDir, cleanup }.
 */
function makeWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), 'agentsnap-test-'));
  const snapDir = join(workspace, 'tests', '__agentsnap__');
  mkdirSync(snapDir, { recursive: true });
  return {
    workspace,
    snapDir,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Run diff.mjs against a workspace. Returns parsed outputs + report + status.
 */
function runDiff(workspace, env = {}) {
  const outputFile = join(workspace, 'gh_output.txt');
  writeFileSync(outputFile, '', 'utf8');
  const reportPath = join(workspace, 'agentsnap-report.json');

  const res = spawnSync(process.execPath, [diffRunner], {
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: outputFile,
      AGENTSNAP_DIR: 'tests/__agentsnap__',
      AGENTSNAP_REPORT_PATH: reportPath,
      ...env,
    },
    encoding: 'utf8',
  });

  const outputs = {};
  for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
    if (!line) continue;
    const eq = line.indexOf('=');
    outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }

  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    /* report may be absent on fatal error */
  }

  return { status: res.status, stdout: res.stdout, stderr: res.stderr, outputs, report };
}

test('matching baseline and current => PASSED, no drift, exit 0', () => {
  const ws = makeWorkspace();
  try {
    writeJson(join(ws.snapDir, 'flow.snap.json'), PASSING_BASELINE);
    // Same structure, different fingerprint (which diff ignores).
    writeJson(join(ws.snapDir, 'flow.current.json'), {
      ...PASSING_BASELINE,
      fingerprint: { node: 'v22.0.0', agentsnap: '0.1.0' },
    });

    const r = runDiff(ws.workspace);

    assert.equal(r.status, 0);
    assert.equal(r.outputs['total-snapshots'], '1');
    assert.equal(r.outputs['drift-count'], '0');
    assert.equal(r.report.results[0].status, 'PASSED');
  } finally {
    ws.cleanup();
  }
});

test('changed tool args => TOOLS_CHANGED drift, exit 1', () => {
  const ws = makeWorkspace();
  try {
    writeJson(join(ws.snapDir, 'flow.snap.json'), PASSING_BASELINE);
    const current = structuredClone(PASSING_BASELINE);
    current.tools[0].args.limit = 25;
    writeJson(join(ws.snapDir, 'flow.current.json'), current);

    const r = runDiff(ws.workspace);

    assert.equal(r.status, 1, 'drift in fail-on set must exit non-zero');
    assert.equal(r.outputs['drift-count'], '1');
    assert.equal(r.report.results[0].status, 'TOOLS_CHANGED');
  } finally {
    ws.cleanup();
  }
});

test('output-only drift not in fail-on => exit 0 but counted as drift', () => {
  const ws = makeWorkspace();
  try {
    writeJson(join(ws.snapDir, 'flow.snap.json'), PASSING_BASELINE);
    const current = structuredClone(PASSING_BASELINE);
    current.output = 'Found 5 coffee shops near you.';
    writeJson(join(ws.snapDir, 'flow.current.json'), current);

    // Only fail on TOOLS_CHANGED — OUTPUT_DRIFT should not fail the run.
    const r = runDiff(ws.workspace, { AGENTSNAP_FAIL_ON: 'TOOLS_CHANGED' });

    assert.equal(r.report.results[0].status, 'OUTPUT_DRIFT');
    assert.equal(r.outputs['drift-count'], '1');
    assert.equal(r.status, 0, 'status not in fail-on must not fail the run');
  } finally {
    ws.cleanup();
  }
});

test('new top-level error => REGRESSION, exit 1', () => {
  const ws = makeWorkspace();
  try {
    writeJson(join(ws.snapDir, 'flow.snap.json'), PASSING_BASELINE);
    const current = structuredClone(PASSING_BASELINE);
    current.error = { name: 'Error', message: 'boom' };
    writeJson(join(ws.snapDir, 'flow.current.json'), current);

    const r = runDiff(ws.workspace);

    assert.equal(r.report.results[0].status, 'REGRESSION');
    assert.equal(r.status, 1);
  } finally {
    ws.cleanup();
  }
});

test('update mode overwrites baseline and never fails', () => {
  const ws = makeWorkspace();
  try {
    writeJson(join(ws.snapDir, 'flow.snap.json'), PASSING_BASELINE);
    const current = structuredClone(PASSING_BASELINE);
    current.tools[0].args.limit = 25;
    writeJson(join(ws.snapDir, 'flow.current.json'), current);

    const r = runDiff(ws.workspace, { AGENTSNAP_UPDATE: '1' });

    assert.equal(r.status, 0);
    assert.equal(r.outputs['drift-count'], '0', 'update mode skips diffing');
    assert.equal(r.report.summary.updated, 1);

    const baselineAfter = readFileSync(join(ws.snapDir, 'flow.snap.json'), 'utf8');
    const currentAfter = readFileSync(join(ws.snapDir, 'flow.current.json'), 'utf8');
    assert.equal(baselineAfter, currentAfter, 'baseline should match current after update');
  } finally {
    ws.cleanup();
  }
});

test('current with no baseline => baseline is created, exit 0', () => {
  const ws = makeWorkspace();
  try {
    writeJson(join(ws.snapDir, 'flow.current.json'), PASSING_BASELINE);

    const r = runDiff(ws.workspace);

    assert.equal(r.status, 0, 'first run should not fail');
    assert.equal(r.report.summary.created, 1);
    assert.equal(r.report.results[0].status, 'CREATED');

    // The baseline file should now exist and match the current trace.
    const created = JSON.parse(readFileSync(join(ws.snapDir, 'flow.snap.json'), 'utf8'));
    assert.deepEqual(created, PASSING_BASELINE);
  } finally {
    ws.cleanup();
  }
});

test('baseline with no current => NO_CURRENT, not counted as drift, exit 0', () => {
  const ws = makeWorkspace();
  try {
    writeJson(join(ws.snapDir, 'flow.snap.json'), PASSING_BASELINE);

    const r = runDiff(ws.workspace);

    assert.equal(r.status, 0);
    assert.equal(r.outputs['drift-count'], '0');
    assert.equal(r.report.results[0].status, 'NO_CURRENT');
  } finally {
    ws.cleanup();
  }
});

test('empty / missing snapshots dir => zero snapshots, exit 0', () => {
  const ws = makeWorkspace();
  try {
    const r = runDiff(ws.workspace, { AGENTSNAP_DIR: 'tests/does-not-exist' });

    assert.equal(r.status, 0);
    assert.equal(r.outputs['total-snapshots'], '0');
    assert.equal(r.outputs['drift-count'], '0');
  } finally {
    ws.cleanup();
  }
});
