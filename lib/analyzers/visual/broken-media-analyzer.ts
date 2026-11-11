import { SEVERITY } from '../../constants';
import type { ChromePage, Issue } from '../../types';
import type { RequestInfo } from '../../crawler/crawler-types';

export interface ImageSnapshot {
  src: string;
  complete: boolean;
  naturalWidth: number;
  displayWidth: number;
  displayHeight: number;
  loading?: string;
}

export interface MediaSnapshot {
  src: string;
  tag: 'video' | 'audio';
  noSource: boolean;
}

export interface FailedMediaRequest {
  url: string;
  status: number;
  resourceType: string;
}

export interface BrokenMediaData {
  brokenImages: string[];
  brokenMedia: string[];
  failedRequests: FailedMediaRequest[];
  issues: Issue[];
}

/** 1×1 / 2×2 tracking pixels that fail are not a visible defect. */
const TRACKING_PIXEL_MAX_PX = 2;
const MEDIA_RESOURCE_TYPES = new Set(['image', 'media']);
const DETAIL_URL_LIMIT = 5;

/** Images that finished loading yet decoded to nothing. Lazy images not yet loaded (`complete` false) are skipped. */
export function classifyBrokenImages(imgs: ImageSnapshot[]): string[] {
  const broken = imgs.filter(
    (img) =>
      img.complete &&
      img.naturalWidth === 0 &&
      !!img.src &&
      !(img.displayWidth <= TRACKING_PIXEL_MAX_PX && img.displayHeight <= TRACKING_PIXEL_MAX_PX),
  );
  return [...new Set(broken.map((img) => img.src))];
}

/** Image/media requests answered with 4xx/5xx, minus URLs already reported as broken images. */
export function classifyFailedMediaRequests(
  requests: Record<string, RequestInfo>,
  alreadyReported: Iterable<string> = [],
): FailedMediaRequest[] {
  const skip = new Set(alreadyReported);
  const out: FailedMediaRequest[] = [];
  for (const [url, req] of Object.entries(requests)) {
    if (!req.resourceType || !MEDIA_RESOURCE_TYPES.has(req.resourceType)) continue;
    if (typeof req.status !== 'number' || req.status < 400) continue;
    if (skip.has(url)) continue;
    out.push({ url, status: req.status, resourceType: req.resourceType });
  }
  return out;
}

function listUrls(urls: string[]): string {
  const shown = urls.slice(0, DETAIL_URL_LIMIT).join(', ');
  return urls.length > DETAIL_URL_LIMIT ? `${shown} (+${urls.length - DETAIL_URL_LIMIT} more)` : shown;
}

class BrokenMediaAnalyzer {
  static async analyze(
    chromePage: ChromePage,
    url: string,
    requests: Record<string, RequestInfo> = {},
  ): Promise<BrokenMediaData> {
    const snapshot = await chromePage.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img')).map((img) => {
        const rect = img.getBoundingClientRect();
        return {
          src: img.currentSrc || img.src,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          displayWidth: rect.width,
          displayHeight: rect.height,
          loading: img.loading,
        };
      });
      const media = Array.from(document.querySelectorAll('video, audio')).map((el) => {
        const m = el as HTMLMediaElement;
        return {
          src: m.currentSrc || (m.getAttribute('src') ?? ''),
          tag: m.tagName.toLowerCase() as 'video' | 'audio',
          noSource: m.networkState === HTMLMediaElement.NETWORK_NO_SOURCE,
        };
      });
      return { imgs, media };
    });

    const brokenImages = classifyBrokenImages(snapshot.imgs);
    const brokenMedia = snapshot.media.filter((m) => m.noSource).map((m) => m.src || `<${m.tag}>`);
    const failedRequests = classifyFailedMediaRequests(requests, brokenImages);
    const issues: Issue[] = [];

    if (brokenImages.length > 0) {
      issues.push({
        severity: SEVERITY.HIGH,
        message: 'Broken images detected',
        detail: `<a href="${url}">${url}</a> has ${brokenImages.length} image(s) that failed to render: ${listUrls(brokenImages)}`,
      });
    }
    const failedUrls = [
      ...failedRequests.map((r) => `${r.url} (${r.status})`),
      ...brokenMedia.filter((src) => !failedRequests.some((r) => r.url === src)),
    ];
    if (failedUrls.length > 0) {
      issues.push({
        severity: SEVERITY.MEDIUM,
        message: 'Failed image or media requests',
        detail: `<a href="${url}">${url}</a> has ${failedUrls.length} image/media resource(s) that failed to load: ${listUrls(failedUrls)}`,
      });
    }

    return { brokenImages, brokenMedia, failedRequests, issues };
  }
}

export { BrokenMediaAnalyzer };
