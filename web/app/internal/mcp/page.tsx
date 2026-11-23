'use client';

import { useState } from 'react';

/** The site's input style fixes a one-line height; these boxes hold several lines of text to copy. */
const BOX = {
  display: 'block',
  width: '100%',
  margin: '16px 0',
  padding: 12,
  fontFamily: 'ui-monospace, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  resize: 'vertical',
} as const;

interface Setup {
  prompt: string;
  command: string;
  url: string;
  replaced: number;
}

/**
 * One click from a logged-in person to a working MCP connection: the app makes their own key and
 * hands it over inside a prompt. Pasted into an AI assistant, the prompt has the assistant connect
 * the server and check it.
 */
export default function McpSetupPage() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'prompt' | 'command' | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/internal/mcp-setup', { method: 'POST' });
      if (res.status === 401) {
        window.location.href = '/internal/login?next=/internal/mcp';
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Setup & { message?: string };
      if (!res.ok) throw new Error(body.message ?? `Failed (${res.status})`);
      setSetup(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
    setBusy(false);
  }

  async function copy(what: 'prompt' | 'command') {
    if (!setup) return;
    await navigator.clipboard.writeText(what === 'prompt' ? setup.prompt : setup.command);
    setCopied(what);
    window.setTimeout(() => setCopied(null), 2500);
  }

  return (
    <section className="section">
      <div className="container">
        <h1 className="section__title section__title--sm">Set up MCP</h1>
        <p className="muted run-details" style={{ maxWidth: 760 }}>
          Use the audits from your AI assistant: start scans, read findings and lead summaries by asking for them. One
          click makes your own key and a prompt; paste the prompt into your assistant and it connects itself.
        </p>

        {!setup && (
          <div className="card" style={{ maxWidth: 760, marginTop: 24 }}>
            <h2>1. Create your setup prompt</h2>
            <p>
              Audits you start through it count as yours. You have one key at a time: creating a new one switches the
              old one off.
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button type="button" className="btn" onClick={create} disabled={busy} data-testid="mcp-create">
              {busy ? 'Creating…' : 'Create my setup prompt'}
            </button>
          </div>
        )}

        {setup && (
          <>
            <div className="card" style={{ maxWidth: 760, marginTop: 24 }}>
              <h2>2. Paste this into your AI assistant</h2>
              <p>
                It holds your key, so treat it like a password. It is shown only now: leave this page and you will need
                a new one.
                {setup.replaced > 0 ? ' Your earlier key no longer works.' : ''}
              </p>
              <textarea
                readOnly
                value={setup.prompt}
                rows={14}
                className="form-input"
                data-testid="mcp-prompt"
                style={{ ...BOX, height: 330 }}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className="btn" onClick={() => copy('prompt')} data-testid="mcp-copy">
                {copied === 'prompt' ? 'Copied' : 'Copy the prompt'}
              </button>
            </div>
            <div className="card" style={{ maxWidth: 760, marginTop: 24 }}>
              <h2>Or do it yourself</h2>
              <p>
                In Claude Code, run this in a terminal. In another client, add an HTTP server with this address and
                header.
              </p>
              <textarea
                readOnly
                value={setup.command}
                rows={3}
                className="form-input"
                style={{ ...BOX, height: 84 }}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className="btn btn--outline" onClick={() => copy('command')}>
                {copied === 'command' ? 'Copied' : 'Copy the command'}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
