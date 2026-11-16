import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chooseScanOrigin, type MainHostProbe } from '../lib/leads/scan-origin';

const never = async (): Promise<MainHostProbe | null> => {
  throw new Error('the www host must not be probed here');
};
const answers = (probe: MainHostProbe | null) => async () => probe;

void describe('chooseScanOrigin', () => {
  void it('uses the listed website when there is no fingerprint landing page', async () => {
    const r = await chooseScanOrigin('acme.com', 'https://acme.com', null, never);
    assert.equal(r.origin, 'https://acme.com');
  });

  void it('uses the listed website when the homepage redirects to another site', async () => {
    const r = await chooseScanOrigin(
      'acme.com',
      'https://acme.com',
      { finalUrl: 'https://other.com/', redirectedTo: 'other.com' },
      never,
    );
    assert.equal(r.origin, 'https://acme.com');
  });

  void it('keeps the landing origin when it is the domain or its www host', async () => {
    const r = await chooseScanOrigin('acme.com', 'https://acme.com', { finalUrl: 'https://www.acme.com/en' }, never);
    assert.deepEqual(r, { origin: 'https://www.acme.com', note: null });
  });

  void it('prefers the www host when the homepage sent the browser to another subdomain (gymshark → checkout)', async () => {
    const r = await chooseScanOrigin(
      'gymshark.com',
      'https://gymshark.com',
      { finalUrl: 'https://us.checkout.gymshark.com/' },
      answers({ status: 200, finalHost: 'www.gymshark.com', challenge: false }),
    );
    assert.equal(r.origin, 'https://www.gymshark.com');
    assert.match(r.note ?? '', /us\.checkout\.gymshark\.com/);
  });

  void it('keeps the landing origin when the www host refuses the request: a block proves nothing', async () => {
    const r = await chooseScanOrigin(
      'fender.com',
      'https://fender.com',
      { finalUrl: 'https://pl.fender.com/?x=1' },
      answers({ status: 403, finalHost: 'www.fender.com', challenge: false }),
    );
    assert.equal(r.origin, 'https://pl.fender.com');
    assert.match(r.note ?? '', /refused the request \(403\)/);
  });

  void it('keeps the landing origin when the www host redirects to the same subdomain (wizards → company)', async () => {
    const r = await chooseScanOrigin(
      'wizards.com',
      'https://wizards.com',
      { finalUrl: 'https://company.wizards.com/en' },
      answers({ status: 200, finalHost: 'company.wizards.com', challenge: false }),
    );
    assert.equal(r.origin, 'https://company.wizards.com');
  });

  void it('keeps the landing origin on a bot challenge or no answer', async () => {
    const landing = { finalUrl: 'https://shop.acme.com/' };
    const challenged = await chooseScanOrigin(
      'acme.com',
      'https://acme.com',
      landing,
      answers({ status: 200, finalHost: 'www.acme.com', challenge: true }),
    );
    assert.equal(challenged.origin, 'https://shop.acme.com');
    const silent = await chooseScanOrigin('acme.com', 'https://acme.com', landing, answers(null));
    assert.equal(silent.origin, 'https://shop.acme.com');
  });
});
