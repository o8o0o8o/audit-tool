'use client';

import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const res = await fetch('/api/internal/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(email ? { email } : {}), password }),
    });
    if (res.ok) {
      const next = new URLSearchParams(window.location.search).get('next');
      window.location.href = next && next.startsWith('/internal') ? next : '/internal';
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    setError(data.message ?? `Login failed (${res.status})`);
    setBusy(false);
  }

  return (
    <section className="section">
      <div className="container">
        <h1 className="section__title section__title--sm">Internal login</h1>
        <form className="internal-form" onSubmit={onSubmit} style={{ maxWidth: 440 }}>
          <div className="contacts-form__item">
            <label className="contacts-form__label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              name="email"
              placeholder="you@company.com"
              type="email"
              autoComplete="username"
              className="form-input"
            />
          </div>
          <div className="contacts-form__item">
            <label className="contacts-form__label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              placeholder="Password"
              type="password"
              autoComplete="current-password"
              required
              className="form-input"
            />
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Checking…' : 'Log in'}
          </button>
        </form>
      </div>
    </section>
  );
}
