'use client';

import Script from 'next/script';
import { useRef, useState, type FormEvent } from 'react';

const SCANS = [
  {
    value: 'quick',
    label: 'Quick scan',
    summary: 'Reads up to 25 published pages of the site. It takes a few minutes.',
  },
  {
    value: 'page',
    label: 'Single page',
    summary: 'Audits only the page whose address you enter.',
  },
] as const;

declare global {
  interface Window {
    turnstile?: { reset: (widget?: string) => void };
  }
}

/** The public form (design §7): an address and one of two scans. The server decides everything else. `siteKey`: the bot check's widget, when one is configured. */
export function PublicScanForm({ siteKey }: { siteKey: string | null }) {
  const [scan, setScan] = useState<'quick' | 'page'>('quick');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const token = String(data.get('cf-turnstile-response') ?? '');
    if (siteKey && !token) {
      setError('Wait for the bot check below to finish, then try again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/public/scans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: String(data.get('url') ?? ''), mode: scan, turnstile_token: token }),
      });
      const body = (await res.json().catch(() => ({}))) as { audit_id?: string; message?: string };
      if (res.ok && body.audit_id) {
        window.location.assign(`/scan/${body.audit_id}`);
        return;
      }
      setError(body.message ?? `The scan could not be started (${res.status}).`);
    } catch {
      setError('The scan could not be started. Check your connection and try again.');
    }
    // A token works once: ask the widget for a new one before the next try.
    window.turnstile?.reset();
    setBusy(false);
  }

  return (
    <form ref={form} className="contacts-form" aria-label="Scan form" onSubmit={onSubmit}>
      {siteKey && <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" />}
      <div className="contacts-form__wrap">
        <div className="contacts-form__item">
          <label className="contacts-form__label" htmlFor="scan-url">
            {scan === 'page' ? 'Page address' : 'Website address'}
          </label>
          <input
            id="scan-url"
            name="url"
            type="text"
            inputMode="url"
            autoComplete="url"
            required
            maxLength={2000}
            placeholder={scan === 'page' ? 'example.com/pricing' : 'example.com'}
            className="form-input"
          />
        </div>
        <div className="contacts-form__item">
          <span className="contacts-form__label" id="scan-type-label">
            Scan
          </span>
          <div className="contacts-form__checklist" role="radiogroup" aria-labelledby="scan-type-label">
            {SCANS.map((s) => (
              <label key={s.value} className="checkbox-button">
                <input
                  name="scan"
                  type="radio"
                  value={s.value}
                  checked={scan === s.value}
                  onChange={() => setScan(s.value)}
                />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
          <p className="contacts-form__hint">{SCANS.find((s) => s.value === scan)?.summary}</p>
        </div>
        {siteKey && (
          <div className="contacts-form__item">
            <div className="cf-turnstile" data-sitekey={siteKey} data-theme="dark" />
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Starting…' : 'Start the scan'}
        </button>
      </div>
    </form>
  );
}
