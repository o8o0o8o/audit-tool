import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateSchemaVocabulary, isSchemaOrgContext, typeAncestors } from '../lib/analyzers/seo/schema-vocabulary';
import { AdvancedSchemaValidator } from '../lib/analyzers/seo/advanced-schema-validator';
import type { PageInfo } from '../lib/types';

const CTX = 'https://schema.org';
const kinds = (fs: { kind: string }[]) => fs.map((f) => f.kind);

void describe('schema.org vocabulary check', () => {
  void it('accepts valid markup, including inherited and nested properties', () => {
    const product = {
      '@context': CTX,
      '@type': 'Product',
      name: 'Shoe',
      sku: 'X1',
      offers: { '@type': 'Offer', price: '10', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.5, reviewCount: 10 },
    };
    assert.deepStrictEqual(validateSchemaVocabulary(product, CTX), []);
  });

  void it('accepts multiple types, prefixed and absolute type IRIs', () => {
    const node = {
      '@type': ['LocalBusiness', 'schema:Restaurant'],
      name: 'X',
      servesCuisine: 'Thai',
      address: 'Main St',
    };
    assert.deepStrictEqual(validateSchemaVocabulary(node, CTX), []);
    assert.deepStrictEqual(validateSchemaVocabulary({ '@type': 'http://schema.org/Person', name: 'A' }, CTX), []);
  });

  void it('flags an unknown type with a suggestion', () => {
    const fs = validateSchemaVocabulary({ '@type': 'Prodcut', name: 'X' }, CTX);
    assert.deepStrictEqual(kinds(fs), ['unknown-type']);
    assert.strictEqual(fs[0].suggestion, 'Product');
  });

  void it('flags an unknown property with a suggestion', () => {
    const fs = validateSchemaVocabulary({ '@type': 'Article', headline: 'H', autor: 'Jane' }, CTX);
    assert.deepStrictEqual(kinds(fs), ['unknown-property']);
    assert.strictEqual(fs[0].property, 'autor');
    assert.strictEqual(fs[0].suggestion, 'author');
  });

  void it('flags a property used outside its domain, in nested nodes too', () => {
    const fs = validateSchemaVocabulary(
      { '@type': 'Article', headline: 'H', author: { '@type': 'Person', name: 'J', price: '5' } },
      CTX,
    );
    assert.deepStrictEqual(kinds(fs), ['property-not-for-type']);
    assert.strictEqual(fs[0].path, 'Person.price');
  });

  void it('reports a missing or foreign @context once and stops', () => {
    assert.deepStrictEqual(kinds(validateSchemaVocabulary({ '@type': 'Prodcut' }, undefined)), ['bad-context']);
    assert.deepStrictEqual(kinds(validateSchemaVocabulary({ '@type': 'X' }, 'https://example.org/vocab')), [
      'bad-context',
    ]);
  });

  void it('ignores other vocabularies and untyped nested objects', () => {
    const node = { '@type': 'Thing', name: 'X', 'og:title': 'y', 'https://example.org/p': 1, identifier: { foo: 1 } };
    assert.deepStrictEqual(validateSchemaVocabulary(node, CTX), []);
  });

  void it('accepts action -input/-output annotations', () => {
    const site = {
      '@type': 'WebSite',
      url: 'https://a.co',
      potentialAction: { '@type': 'SearchAction', target: 'https://a.co/?q={q}', 'query-input': 'required name=q' },
    };
    assert.deepStrictEqual(validateSchemaVocabulary(site, CTX), []);
  });

  void it('recognises schema.org contexts', () => {
    assert.ok(isSchemaOrgContext('http://schema.org'));
    assert.ok(isSchemaOrgContext('https://schema.org/'));
    assert.ok(isSchemaOrgContext(['https://schema.org', { foo: 'bar' }]));
    assert.ok(isSchemaOrgContext({ '@vocab': 'https://schema.org/' }));
    assert.ok(!isSchemaOrgContext('unknown'));
  });

  void it('resolves type ancestors', () => {
    const a = typeAncestors('BlogPosting');
    assert.ok(a.has('Article') && a.has('CreativeWork') && a.has('Thing'));
  });

  void it('surfaces findings through AdvancedSchemaValidator with stable messages', () => {
    const raw = {
      '@context': CTX,
      '@type': 'Organization',
      name: 'Acme',
      url: 'https://a.co',
      logo: 'l.png',
      sameAs: [],
      foundr: 'J',
    };
    const pageData = {
      structuredData: { jsonLdSchemas: [{ type: 'Organization', context: CTX, raw }] },
    } as unknown as PageInfo;
    const res = AdvancedSchemaValidator.validate(pageData, 'https://a.co/');
    const all = [...res.issues, ...res.warnings];
    const hit = all.find((i) => i.message === 'Unknown schema.org property in structured data');
    assert.ok(hit, 'vocabulary finding reported');
    assert.match(hit.detail ?? '', /did you mean &quot;|did you mean "/);
    assert.strictEqual(hit.severity, 'low');
  });
});
