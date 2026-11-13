import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAuditProcess } from '../lib/leads/run-audit';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

void describe('audit runner', () => {
  void it('reports a clean exit and passes the arguments through', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-audit-'));
    const logFile = path.join(dir, 'nested', 'run.log');
    const result = await runAuditProcess(['--origin=https://example.com', '--lead'], {
      timeoutMs: 10_000,
      logFile,
      command: ['node', '-e', 'console.log(process.argv.slice(1).join(" "))', '--'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.timedOut, false);
    assert.equal(fs.readFileSync(logFile, 'utf8').trim(), '--origin=https://example.com --lead');
  });

  void it('reports a failing exit code', async () => {
    const result = await runAuditProcess([], {
      timeoutMs: 10_000,
      command: ['node', '-e', 'process.exit(3)'],
      logFile: path.join(os.tmpdir(), 'run-audit-fail.log'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.timedOut, false);
  });

  void it('stops the whole process tree when the time limit is reached', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-audit-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    // A parent that starts a long-lived child of its own, like start.ts → node → Chromium.
    const script = `
      const { spawn } = require('child_process');
      const child = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setTimeout(() => {}, 60000);
    `;
    const started = Date.now();
    const result = await runAuditProcess([], {
      timeoutMs: 700,
      killAfterMs: 300,
      command: ['node', '-e', script],
      logFile: path.join(dir, 'run.log'),
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 8000, 'returns soon after the limit');

    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(alive(grandchild), false, 'the grandchild is gone too');
  });
});
