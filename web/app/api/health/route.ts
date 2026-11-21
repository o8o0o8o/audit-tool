import { MODEL_VERSION } from '@/lib/platform/model';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ok: true, modelVersion: MODEL_VERSION });
}
