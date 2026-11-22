import { CRON_STEPS, cronSteps, type CronStepName } from '../../../../lib/core/cron-steps';
import { safeEqual } from '../../../../lib/core/tokens';
import { ctx } from '../../../../lib/server';

export const dynamic = 'force-dynamic';
/** The loader works for up to 4 minutes of one invocation (design §3 "Saving a run"). */
export const maxDuration = 300;
const LOADER_BUDGET_MS = 240_000;

/**
 * One cron step per request, scheduled in `vercel.json`. Vercel calls with
 * `Authorization: Bearer $CRON_SECRET`; anything else is refused, and so is every call while the
 * secret is not set.
 */
export async function GET(request: Request, { params }: { params: Promise<{ step: string }> }) {
  const secret = process.env.CRON_SECRET;
  const sent = request.headers.get('authorization') ?? '';
  if (!secret || secret.length < 16 || !safeEqual(sent, `Bearer ${secret}`))
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  const { step } = await params;
  if (!(CRON_STEPS as readonly string[]).includes(step)) return Response.json({ error: 'not_found' }, { status: 404 });
  const { db, platform } = ctx();
  try {
    const steps = cronSteps(db, platform, { loaderBudgetMs: LOADER_BUDGET_MS, gateRetention: false });
    const result = await steps[step as CronStepName]();
    return Response.json({ step, skipped: result === null, result: result ?? null });
  } catch (err) {
    console.error(`[cron] ${step} failed`, err);
    return Response.json({ step, error: 'failed' }, { status: 500 });
  }
}
