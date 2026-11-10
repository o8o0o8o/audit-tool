/**
 * Render the fixture audit through the real generateHTML pipeline into
 * web/public/report/index.html, so the report can be previewed (and probed)
 * from the Next dev server at /report/index.html.
 */
import * as fs from 'fs';
import * as path from 'path';
import { generateHTML } from '../generateHTML';

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'tests', 'fixtures', 'report-fixture', 'audit.json');
const outDir = path.join(root, 'web', 'public', 'report');
const outFile = path.join(outDir, 'index.html');

fs.mkdirSync(outDir, { recursive: true });
generateHTML(fixture, 'fixture.example', outFile);
