import { SEVERITY } from '../../constants';
import type { ChromePage, Issue } from '../../types';
import type { RequestInfo } from '../../crawler/crawler-types';
import { type DocRect, type VisualHighlight, capHighlights } from './visual-highlights';

export interface ImageSnapshot {
  src: string;
  complete: boolean;
  naturalWidth: number;
  displayWidth: number;
  displayHeight: number;
  loading?: string;
  /** Document-coordinate box, for screenshot highlighting. */
  rect?: DocRect;
}

export interface MediaSnapshot {
  src: string;
  tag: 'video' | 'audio';
  noSource: boolean;
  rect?: DocRect;
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
  /** Where each defect sits on the page (document coords); absent on older audits. */
  highlights?: VisualHighlight[];
}

export const BROKEN_IMAGES_MESSAGE = 'Broken images detected';
export const FAILED_MEDIA_MESSAGE = 'Failed image or media requests';

/** Locate the elements behind each broken/failed URL so the report can box them on a screenshot. */
export function buildMediaHighlights(
  imgs: ImageSnapshot[],
  media: MediaSnapshot[],
  brokenImages: string[],
  failedRequests: FailedMediaRequest[],
  brokenMedia: string[],
): VisualHighlight[] {
  const out: VisualHighlight[] = [];
  const broken = new Set(brokenImages);
  for (const img of imgs) {
    if (img.rect && broken.has(img.src)) out.push({ kind: BROKEN_IMAGES_MESSAGE, rect: img.rect, label: 'broken image' });
  }
  const failed = new Map(failedRequests.map((r) => [r.url, r.status]));
  for (const el of [...imgs, ...media]) {
    if (!el.rect) continue;
    const status = failed.get(el.src);
    if (status !== undefined) out.push({ kind: FAILED_MEDIA_MESSAGE, rect: el.rect, label: `HTTP ${status}` });
  }
  const noSource = new Set(brokenMedia);
  for (const m of media) {
    if (m.rect && noSource.has(m.src || `<${m.tag}>`) && !failed.has(m.src)) {
      out.push({ kind: FAILED_MEDIA_MESSAGE, rect: m.rect, label: `${m.tag} failed to load` });
    }
  }
  return capHighlights(out);
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
      const docRect = (r: DOMRect) =>
        r.width > 0 && r.height > 0
          ? { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
          : undefined;
      const imgs = Array.from(document.querySelectorAll('img')).map((img) => {
        const rect = img.getBoundingClientRect();
        return {
          src: img.currentSrc || img.src,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          displayWidth: rect.width,
          displayHeight: rect.height,
          loading: img.loading,
          rect: docRect(rect),
        };
      });
      const media = Array.from(document.querySelectorAll('video, audio')).map((el) => {
        const m = el as HTMLMediaElement;
        return {
          src: m.currentSrc || (m.getAttribute('src') ?? ''),
          tag: m.tagName.toLowerCase() as 'video' | 'audio',
          noSource: m.networkState === HTMLMediaElement.NETWORK_NO_SOURCE,
          rect: docRect(m.getBoundingClientRect()),
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
        message: BROKEN_IMAGES_MESSAGE,
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
        message: FAILED_MEDIA_MESSAGE,
        detail: `<a href="${url}">${url}</a> has ${failedUrls.length} image/media resource(s) that failed to load: ${listUrls(failedUrls)}`,
      });
    }

    const highlights = buildMediaHighlights(snapshot.imgs, snapshot.media, brokenImages, failedRequests, brokenMedia);
    return { brokenImages, brokenMedia, failedRequests, issues, highlights };
  }
}

export { BrokenMediaAnalyzer };
