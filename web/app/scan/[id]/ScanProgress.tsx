'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface View {
  status: 'running' | 'succeeded' | 'failed';
  processed: number | null;
  total: number | null;
}

/** Shows a running public scan and reloads the page when it ends, so the server renders the report. */
export function ScanProgress({ auditId, initial }: { auditId: string; initial: View }) {
  const router = useRouter();
  const [view, setView] = useState<View>(initial);

  useEffect(() => {
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/public/scans/${auditId}`, { cache: 'no-store' });
        if (!res.ok || stopped) return;
        const next = (await res.json()) as View;
        setView(next);
        if (next.status !== 'running') {
          window.clearInterval(timer);
          router.refresh();
        }
      } catch {
        /* a failed poll: the next one tries again */
      }
    }, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [auditId, router]);

  const pct = view.total ? Math.min(100, Math.round(((view.processed ?? 0) / view.total) * 100)) : 0;
  return (
    <div className="card" aria-busy="true" data-testid="scan-progress">
      <h2>{view.total ? 'Scan running' : 'Starting the scan…'}</h2>
      <p className="muted">This page updates by itself. You can keep the link and come back later.</p>
      <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="progress-bar-fill" style={{ width: `${view.total ? pct : 4}%` }} />
      </div>
      {view.total ? (
        <p className="progress-count">
          {view.processed ?? 0} of {view.total} pages
        </p>
      ) : (
        <p className="progress-count">Waiting for a worker</p>
      )}
    </div>
  );
}
