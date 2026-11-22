import { cronRetention, cronTick } from '../../../../lib/core/cron-steps';
import { safeEqual } from '../../../../lib/core/tokens';
import { ctx } from '../../../../lib/server';

export const dynamic = 'force-dynamic';
/** The loader works for up to 4 minutes of one invocation (design §3 "Saving a run"). */
export const maxDuration = 300;
const LOADER_BUDGET_MS = 240_000;

/**
 * The platform's two timers: `tick` (every 5 minutes: reaper, dispatch, jobs, loader, rescore,
 * webhooks) and `retention` (daily). Called by `.github/workflows/platform-cron.yml` with
 * `Authorization: Bearer $CRON_SECRET`, which is also what a Vercel cron sends; anything else is
 * refused, and so is every call while the secret is not set.
 */
export async function GET(request: Request, { params }: { params: Promise<{ step: string }> }) {
  const secret = process.env.CRON_SECRET;
  const sent = request.headers.get('authorization') ?? '';
  if (!secret || secret.length < 16 || !safeEqual(sent, `Bearer ${secret}`))
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  const { step } = await params;
  if (step !== 'tick' && step !== 'retention') return Response.json({ error: 'not_found' }, { status: 404 });
  const { db, platform } = ctx();
  try {
    if (step === 'retention') return Response.json({ step, result: (await cronRetention(db, platform)) ?? null });
    const result = await cronTick(db, platform, { loaderBudgetMs: LOADER_BUDGET_MS });
    const failed = result ? Object.values(result).some((r) => !r.ok) : false;
    return Response.json({ step, skipped: result === null, result }, { status: failed ? 500 : 200 });
  } catch (err) {
    console.error(`[cron] ${step} failed`, err);
    return Response.json({ step, error: 'failed' }, { status: 500 });
  }
}
