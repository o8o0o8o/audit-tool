'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The sandboxed report at its full height: the report (served with ?embed=1) posts its document
 * height, so the page scrolls as one, with no scrollbar inside the frame.
 */
export function ReportFrame({ src }: { src: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const h = (e.data as { type?: string; height?: number } | null)?.height;
      if ((e.data as { type?: string })?.type === 'audit-report-height' && typeof h === 'number' && h > 0)
        setHeight((prev) => (prev === Math.ceil(h) ? prev : Math.ceil(h)));
    };
    window.addEventListener('message', onMessage);
    // The report may have loaded before this listener existed: ask it for its height now.
    const ping = () => ref.current?.contentWindow?.postMessage({ type: 'audit-report-ping' }, '*');
    ping();
    const frame = ref.current;
    frame?.addEventListener('load', ping);
    return () => {
      window.removeEventListener('message', onMessage);
      frame?.removeEventListener('load', ping);
    };
  }, []);
  return (
    <iframe
      ref={ref}
      className="report-embed"
      data-testid="report-frame"
      src={src}
      title="Audit report"
      scrolling="no"
      style={height ? { height } : undefined}
    />
  );
}
