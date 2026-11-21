'use client';

import { useEffect, useState, type FormEvent } from 'react';

interface Key {
  id: string;
  name: string;
  scopes: string[];
  rateLimitPerHour: number;
  webhookUrl: string | null;
  createdAt: string;
  revokedAt: string | null;
}

const ALL_SCOPES = [
  'audits:read',
  'audits:start:quick',
  'audits:start:full',
  'audits:pdf',
  'audits:cancel',
  'audits:publish',
  'prospects:read',
  'prospects:write',
];

export default function KeysPage() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [created, setCreated] = useState<{ key: string; webhookSecret: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch('/api/internal/keys', { cache: 'no-store' });
    if (res.status === 401) window.location.href = '/internal/login?next=/internal/keys';
    else setKeys(((await res.json()) as { keys: Key[] }).keys);
  }
  useEffect(() => void load(), []);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const res = await fetch('/api/internal/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: f.get('name'),
        scopes: f.getAll('scopes').join(','),
        rate: Number(f.get('rate')) || 60,
        webhookUrl: f.get('webhookUrl'),
      }),
    });
    const data = (await res.json()) as { key?: string; webhookSecret?: string | null; message?: string };
    if (!res.ok || !data.key) setError(data.message ?? `Error ${res.status}`);
    else {
      setError(null);
      setCreated({ key: data.key, webhookSecret: data.webhookSecret ?? null });
      void load();
    }
  }

  async function revoke(id: string) {
    await fetch(`/api/internal/keys/${id}/revoke`, { method: 'POST' });
    void load();
  }

  return (
    <section className="section">
      <div className="container">
        <h1 className="section__title section__title--sm">API keys</h1>
        {created && (
          <div className="card run-details" role="status">
            <p>Copy the key now; it is not shown again.</p>
            <code data-testid="new-key" style={{ wordBreak: 'break-all' }}>
              {created.key}
            </code>
            {created.webhookSecret && (
              <p>
                Webhook secret: <code style={{ wordBreak: 'break-all' }}>{created.webhookSecret}</code>
              </p>
            )}
          </div>
        )}
        <form className="contacts-form" onSubmit={create} style={{ maxWidth: 640 }}>
          <div className="contacts-form__item">
            <label className="contacts-form__label" htmlFor="key-name">
              Name
            </label>
            <input id="key-name" name="name" required className="form-input" />
          </div>
          <div className="contacts-form__item">
            <span className="contacts-form__label">Scopes</span>
            <div className="contacts-form__checklist">
              {ALL_SCOPES.map((s) => (
                <label key={s} className="checkbox-button">
                  <input type="checkbox" name="scopes" value={s} defaultChecked={s === 'audits:read'} />
                  <span>{s}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="contacts-form__item">
            <label className="contacts-form__label" htmlFor="key-rate">
              Calls per hour
            </label>
            <input id="key-rate" name="rate" type="number" defaultValue={60} className="form-input" />
          </div>
          <div className="contacts-form__item">
            <label className="contacts-form__label" htmlFor="key-webhook">
              Webhook URL (optional)
            </label>
            <input id="key-webhook" name="webhookUrl" className="form-input" />
          </div>
          {error && <p className="error">{error}</p>}
          <button className="btn" type="submit">
            Create key
          </button>
        </form>
        <ul className="run-list">
          {keys.map((k) => (
            <li key={k.id}>
              <strong>{k.name}</strong>{' '}
              <span className="muted">
                {k.scopes.join(', ')} · {k.rateLimitPerHour}/h{k.webhookUrl ? ` · webhook ${k.webhookUrl}` : ''}
              </span>{' '}
              {k.revokedAt ? (
                <span className="muted">revoked {k.revokedAt.slice(0, 10)}</span>
              ) : (
                <button type="button" className="btn btn--outline" onClick={() => void revoke(k.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
