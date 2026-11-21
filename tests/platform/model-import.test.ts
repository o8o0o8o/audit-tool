import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOL_MAJOR, toCliArgs, normalizeRunOptions, profileHash } from '@model/run-options';

void test('TOOL_MAJOR follows package.json', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  assert.equal(TOOL_MAJOR, Number(pkg.version.split('.')[0]));
});

void test('run options: quick scans ignore options; equal requests hash equal', () => {
  const a = normalizeRunOptions('quick', { perf: true, limit: 5 });
  const b = normalizeRunOptions('quick', {});
  assert.equal(profileHash('quick', 'standard', a), profileHash('quick', 'standard', b));
  assert.notEqual(profileHash('quick', 'standard', a), profileHash('quick', 'public', a));
  assert.deepEqual(toCliArgs({ mode: 'quick', url: 'https://a.com', profile: 'standard', options: a }), [
    '--origin=https://a.com',
    '--lead',
    '--visual',
  ]);
  assert.deepEqual(
    toCliArgs({
      mode: 'page',
      url: 'https://a.com/x',
      profile: 'public',
      options: normalizeRunOptions('page', { pdf: true }),
      proceed: true,
    }),
    ['--page=https://a.com/x', '--passive', '--profile=public', '--pdf', '--proceed'],
  );
});
