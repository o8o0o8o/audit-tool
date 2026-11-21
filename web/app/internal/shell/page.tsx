export const dynamic = 'force-static';

/**
 * The site shell with nothing in it: the root layout's header and footer around an empty main.
 * /internal/audits/<id>/view reads it to put the same header and footer around a report, so the
 * header and footer exist only in app/components/ (lib/report-shell.ts).
 */
export default function Shell() {
  return <div data-report-slot="" />;
}
