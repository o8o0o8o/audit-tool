import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { blobStoreId, publicBlobUrl, runIdStartedAt } from '../web/lib/blob';
import { newRunId } from '../web/lib/audit-options';

describe('web blob helpers', () => {
  it('reads the store id from the read-write token', () => {
    assert.equal(blobStoreId({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_AbC123_secretpart' }), 'AbC123');
  });

  it('falls back to BLOB_STORE_ID and strips the store_ prefix', () => {
    assert.equal(blobStoreId({ BLOB_STORE_ID: 'store_xyz' }), 'xyz');
    assert.equal(blobStoreId({ BLOB_STORE_ID: 'xyz' }), 'xyz');
    assert.equal(blobStoreId({}), null);
  });

  it('builds the public blob URL from a pathname', () => {
    assert.equal(
      publicBlobUrl('audits/run/status.json', { BLOB_STORE_ID: 'store_xyz' }),
      'https://xyz.public.blob.vercel-storage.com/audits/run/status.json',
    );
    assert.throws(() => publicBlobUrl('a', {}));
  });

  it('reads the start time back from a run id', () => {
    const now = new Date('2026-11-20T09:08:07Z');
    assert.equal(runIdStartedAt(newRunId(now))?.toISOString(), now.toISOString());
    assert.equal(runIdStartedAt('not-a-stamped-id'), null);
  });
});
