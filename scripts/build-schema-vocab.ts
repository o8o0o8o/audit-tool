/**
 * Build the compact schema.org vocabulary used by the structured-data
 * vocabulary check (lib/analyzers/seo/schema-vocabulary.ts).
 *
 * Usage:
 *   npx tsx scripts/build-schema-vocab.ts [path-or-url]
 *
 * Default source: https://schema.org/version/latest/schemaorg-current-https.jsonld
 * Output: lib/data/schema-org-vocab.json
 *   { version, types: { Type: [directParents] }, properties: { prop: [domainTypes] } }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_SOURCE = 'https://schema.org/version/latest/schemaorg-current-https.jsonld';
const OUT = join(__dirname, '..', 'lib', 'data', 'schema-org-vocab.json');

type Ref = { '@id': string };
interface Node {
  '@id': string;
  '@type': string | string[];
  'rdfs:subClassOf'?: Ref | Ref[];
  'schema:domainIncludes'?: Ref | Ref[];
  'schema:isPartOf'?: Ref | Ref[];
}

const strip = (id: string) => id.replace(/^schema:/, '');
const refs = (r: Ref | Ref[] | undefined) => (r == null ? [] : Array.isArray(r) ? r : [r]).map((x) => x['@id']);
const asArray = (t: string | string[]) => (Array.isArray(t) ? t : [t]);

async function load(source: string): Promise<{ '@graph': Node[] }> {
  if (/^https?:/.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${source}`);
    return (await res.json()) as { '@graph': Node[] };
  }
  return JSON.parse(readFileSync(source, 'utf8')) as { '@graph': Node[] };
}

async function main() {
  const source = process.argv[2] ?? DEFAULT_SOURCE;
  const graph = (await load(source))['@graph'];

  const types: Record<string, string[]> = {};
  const properties: Record<string, string[]> = {};

  for (const node of graph) {
    const id = node['@id'];
    if (!id?.startsWith('schema:')) continue;
    const nodeTypes = asArray(node['@type']);
    const name = strip(id);

    if (nodeTypes.includes('rdfs:Class')) {
      types[name] = refs(node['rdfs:subClassOf'])
        .filter((p) => p.startsWith('schema:'))
        .map(strip)
        .sort();
    }
    if (nodeTypes.includes('rdf:Property')) {
      properties[name] = refs(node['schema:domainIncludes'])
        .filter((p) => p.startsWith('schema:'))
        .map(strip)
        .sort();
    }
  }

  const sortObj = <T>(o: Record<string, T>) =>
    Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]),
    ) as Record<string, T>;

  const out = {
    source,
    generatedAt: new Date().toISOString().slice(0, 10),
    types: sortObj(types),
    properties: sortObj(properties),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out) + '\n');
  console.log(`Wrote ${Object.keys(types).length} types, ${Object.keys(properties).length} properties → ${OUT}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
