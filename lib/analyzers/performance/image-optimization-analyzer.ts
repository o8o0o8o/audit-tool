import { SEVERITY, THRESHOLDS } from '../../constants';
import type { ChromePage, Issue } from '../../types';

interface RequestEntry {
  size?: number | null;
  resourceType?: string;
  status?: number;
}

/** A single parsed candidate inside a srcset, e.g. `foo-800.webp 800w` → { url:"foo-800.webp", value:800, kind:"w" }. */
interface SrcsetCandidate {
  url: string;
  value: number;
  kind: 'w' | 'x';
}

/**
 * Parse a srcset attribute into structured candidates.
 * Returns [] for empty/malformed input. Descriptor-less candidates are treated as `1x`.
 */
export function parseSrcset(raw: string): SrcsetCandidate[] {
  if (!raw) return [];
  const out: SrcsetCandidate[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const url = tokens[0];
    const descriptor = tokens[1];
    if (!url) continue;
    if (!descriptor) {
      out.push({ url, value: 1, kind: 'x' });
    } else if (/^\d+(?:\.\d+)?w$/i.test(descriptor)) {
      out.push({ url, value: parseFloat(descriptor), kind: 'w' });
    } else if (/^\d+(?:\.\d+)?x$/i.test(descriptor)) {
      out.push({ url, value: parseFloat(descriptor), kind: 'x' });
    }
    // Unrecognised descriptors are skipped silently
  }
  return out;
}

/** Natural pixels below this share of display × DPR count as visibly upscaled. */
const UPSCALE_TOLERANCE = 0.8;
const BACKGROUND_SCAN_CAP = 30;
const BACKGROUND_DECODE_TIMEOUT_MS = 2000;
const BACKGROUND_TOTAL_BUDGET_MS = 3000;

export interface UpscaleImageInput {
  src: string | null;
  srcset: string;
  naturalWidth: number;
  displayWidth: number;
}

export interface BackgroundImageInput {
  url: string;
  naturalWidth: number;
  naturalHeight: number;
  elementWidth: number;
  elementHeight: number;
  backgroundSize: string;
  backgroundRepeat: string;
}

const isVectorOrInline = (src: string) => /^data:/i.test(src) || /\.svg(?:[?#]|$)/i.test(src);

const isUpscaled = (natural: number, rendered: number, dpr: number) =>
  natural > 0 && rendered > 0 && natural < rendered * dpr * UPSCALE_TOLERANCE;

/** True when an `<img>` without srcset is drawn wider than its natural resolution supports. */
export function classifyUpscaledImage(img: UpscaleImageInput, dpr: number): boolean {
  if (!img.src || img.srcset || isVectorOrInline(img.src)) return false;
  return isUpscaled(img.naturalWidth, img.displayWidth, dpr);
}

/** Rendered width of a background image, or null when the size cannot be resolved. */
function renderedBackgroundWidth(bg: BackgroundImageInput): number | null {
  const { naturalWidth: nw, naturalHeight: nh, elementWidth: ew, elementHeight: eh } = bg;
  const size = bg.backgroundSize.trim().toLowerCase();
  if (size === 'cover') return nw * Math.max(ew / nw, eh / nh);
  if (size === 'contain') return nw * Math.min(ew / nw, eh / nh);
  const first = size.split(/\s+/)[0] ?? 'auto';
  if (first === 'auto' || first === '') return nw;
  const px = /^([\d.]+)px$/.exec(first);
  if (px) return parseFloat(px[1]);
  const pct = /^([\d.]+)%$/.exec(first);
  if (pct) return (ew * parseFloat(pct[1])) / 100;
  return null;
}

/** True when a non-repeating CSS background is stretched beyond its natural resolution. */
export function classifyBackgroundUpscale(bg: BackgroundImageInput, dpr: number): boolean {
  if (isVectorOrInline(bg.url)) return false;
  if (!/^no-repeat(?:\s+no-repeat)?$/.test(bg.backgroundRepeat.trim())) return false;
  if (bg.naturalWidth <= 0 || bg.naturalHeight <= 0 || bg.elementWidth <= 0 || bg.elementHeight <= 0) return false;
  const rendered = renderedBackgroundWidth(bg);
  return rendered !== null && isUpscaled(bg.naturalWidth, rendered, dpr);
}

class ImageOptimizationAnalyzer {
  static async analyzeImageOptimization(chromePage: ChromePage, requests: Record<string, RequestEntry>, url: string) {
    const imageAnalysis = {
      totalImages: 0,
      totalImageSize: 0,
      oversizedImages: [] as {
        src: string;
        size: number;
        naturalWidth: number;
        naturalHeight: number;
        displayWidth: number;
        displayHeight: number;
      }[],
      modernFormats: 0,
      legacyFormats: 0,
      withLazyLoading: 0,
      withoutLazyLoading: 0,
      withoutAlt: 0,
      // srcset / sizes correctness (A3.1)
      withSrcset: 0,
      srcsetSingleCandidate: [] as string[], // srcset with only one candidate (redundant)
      srcsetMissingSizes: [] as string[],    // uses w descriptors but no sizes attribute
      srcsetOverfetch: [] as { src: string; pickedWidth: number; targetWidth: number }[],
      srcsetUnderRes: [] as { src: string; pickedWidth: number; targetWidth: number }[],
      issues: [] as Issue[],
    };

    // Get all images with their properties (incl. srcset/sizes context for picked-candidate analysis)
    const { devicePixelRatio, imageElements } = await chromePage.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return {
        devicePixelRatio: window.devicePixelRatio || 1,
        imageElements: imgs.map((img) => ({
          src: img.src || img.getAttribute('src'),
          currentSrc: img.currentSrc || '', // URL the browser actually fetched
          srcset: img.getAttribute('srcset') || '',
          sizes: img.getAttribute('sizes') || '',
          loading: img.loading, // 'lazy', 'eager', or undefined
          width: img.width,
          height: img.height,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          alt: img.alt,
          displayWidth: img.getBoundingClientRect().width,
          displayHeight: img.getBoundingClientRect().height,
        })),
      };
    });

    imageAnalysis.totalImages = imageElements.length;

    const upscaledImages = imageElements.filter((img) => classifyUpscaledImage(img, devicePixelRatio));
    const backgrounds = await ImageOptimizationAnalyzer.collectBackgrounds(chromePage);
    const upscaledBackgrounds = backgrounds.filter((bg) => classifyBackgroundUpscale(bg, devicePixelRatio));

    for (const img of imageElements) {
      // Check alt attribute
      if (!img.alt || img.alt.trim() === '') {
        imageAnalysis.withoutAlt++;
      }

      // Check lazy loading
      if (img.loading === 'lazy') {
        imageAnalysis.withLazyLoading++;
      } else {
        imageAnalysis.withoutLazyLoading++;
      }

      // Analyze image from requests
      if (img.src && requests[img.src]) {
        const imgRequest = requests[img.src];
        const size = imgRequest.size ?? 0;

        imageAnalysis.totalImageSize += size;

        // Check image format
        const imgPath = img.src.toLowerCase().split('?')[0]; // strip query params
        if (imgPath.endsWith('.webp') || imgPath.endsWith('.avif')) {
          imageAnalysis.modernFormats++;
        } else if (
          imgPath.endsWith('.jpg') ||
          imgPath.endsWith('.jpeg') ||
          imgPath.endsWith('.png') ||
          imgPath.endsWith('.gif')
        ) {
          imageAnalysis.legacyFormats++;
        }

        // Check image size
        if (size > THRESHOLDS.IMAGE_SIZE_MAX) {
          imageAnalysis.oversizedImages.push({
            src: img.src,
            size: size,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            displayWidth: Math.round(img.displayWidth),
            displayHeight: Math.round(img.displayHeight),
          });
        }

        // Check if image is scaled down significantly (wasting bandwidth)
        if (img.naturalWidth && img.displayWidth) {
          const widthRatio = img.naturalWidth / img.displayWidth;
          const heightRatio = img.naturalHeight / img.displayHeight;

          if (widthRatio > 2 || heightRatio > 2) {
            imageAnalysis.issues.push({
              severity: SEVERITY.MEDIUM,
              message: `Some images are significantly larger than their display size`,
              // Don't embed the raw image src: CDN URLs are opaque hashes that
              // truncate badly and, as a second URL in the detail, make the
              // curated report mis-cluster this single-page finding under a
              // "Pages sharing this value" group. The page + dimensions are the
              // actionable signal.
              detail: `<a href="${url}">${url}</a> serves an image at ${img.naturalWidth}×${img.naturalHeight} but displays it at ${Math.round(img.displayWidth)}×${Math.round(img.displayHeight)} — downscaled in the browser, wasting bandwidth.`,
            });
          }
        }
      }

      // ── A3.1: srcset / sizes correctness ──────────────────────────────────
      if (img.srcset) {
        imageAnalysis.withSrcset++;
        const candidates = parseSrcset(img.srcset);

        // Single-candidate srcset is redundant (browser doesn't need the descriptor)
        if (candidates.length === 1 && img.src) {
          imageAnalysis.srcsetSingleCandidate.push(img.src);
        }

        // w-descriptors without a sizes attribute → browser uses 100vw default
        const hasWDescriptor = candidates.some((c) => c.kind === 'w');
        if (hasWDescriptor && !img.sizes && img.src) {
          imageAnalysis.srcsetMissingSizes.push(img.src);
        }

        // Find the candidate that matches the browser-picked URL, then compare
        // its width against the display-width × DPR target.
        if (img.currentSrc && img.displayWidth > 0) {
          const picked = candidates.find((c) => c.url === img.currentSrc);
          const targetWidth = img.displayWidth * devicePixelRatio;
          if (picked) {
            const pickedWidth = picked.kind === 'w' ? picked.value : img.displayWidth * picked.value;
            // Over-fetching: picked candidate is much wider than needed
            if (pickedWidth > targetWidth * 1.5 && pickedWidth - targetWidth > 200) {
              imageAnalysis.srcsetOverfetch.push({
                src: img.currentSrc,
                pickedWidth: Math.round(pickedWidth),
                targetWidth: Math.round(targetWidth),
              });
            }
            // Under-resolution: picked candidate is smaller than the display target
            if (pickedWidth < targetWidth * 0.8 && targetWidth - pickedWidth > 100) {
              imageAnalysis.srcsetUnderRes.push({
                src: img.currentSrc,
                pickedWidth: Math.round(pickedWidth),
                targetWidth: Math.round(targetWidth),
              });
            }
          }
        }
      }
    }

    // ── A3.1 aggregate issues ────────────────────────────────────────────────
    if (imageAnalysis.srcsetOverfetch.length > 0) {
      const examples = imageAnalysis.srcsetOverfetch
        .slice(0, 3)
        .map((i) => `${i.src.substring(0, 60)} (got ${i.pickedWidth}px, needed ~${i.targetWidth}px)`)
        .join(', ');
      imageAnalysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `Some images download larger srcset candidates than they need`,
        detail: `<a href="${url}">${url}</a>: ${imageAnalysis.srcsetOverfetch.length} image(s) had the browser pick a srcset candidate >1.5× the display target. Tighten the \`sizes\` attribute. Examples: ${examples}`,
      });
    }

    if (imageAnalysis.srcsetUnderRes.length > 0) {
      const examples = imageAnalysis.srcsetUnderRes
        .slice(0, 3)
        .map((i) => `${i.src.substring(0, 60)} (got ${i.pickedWidth}px, needed ~${i.targetWidth}px)`)
        .join(', ');
      imageAnalysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `Some images load smaller srcset candidates than display target`,
        detail: `<a href="${url}">${url}</a>: ${imageAnalysis.srcsetUnderRes.length} image(s) had the browser pick a srcset candidate noticeably smaller than displayWidth × DPR. These will look blurry on high-density displays. Examples: ${examples}`,
      });
    }

    if (imageAnalysis.srcsetMissingSizes.length > 0) {
      const examples = imageAnalysis.srcsetMissingSizes.slice(0, 3).map((s) => s.substring(0, 60)).join(', ');
      imageAnalysis.issues.push({
        severity: SEVERITY.LOW,
        message: `Some images have srcset but no sizes attribute`,
        detail: `<a href="${url}">${url}</a>: ${imageAnalysis.srcsetMissingSizes.length} image(s) use w-descriptor srcset without a sizes hint. The browser falls back to 100vw, which usually picks a too-large candidate. Examples: ${examples}`,
      });
    }

    if (imageAnalysis.srcsetSingleCandidate.length > 0 && imageAnalysis.srcsetSingleCandidate.length === imageAnalysis.withSrcset) {
      imageAnalysis.issues.push({
        severity: SEVERITY.LOW,
        message: `All srcset declarations have a single candidate`,
        detail: `<a href="${url}">${url}</a>: ${imageAnalysis.srcsetSingleCandidate.length} image(s) declare srcset with only one URL. The descriptor adds nothing — either drop srcset or add more candidates.`,
      });
    }

    if (upscaledImages.length > 0) {
      const examples = upscaledImages
        .slice(0, 3)
        .map((i) => `${i.naturalWidth}px natural shown at ${Math.round(i.displayWidth)}px`)
        .join(', ');
      imageAnalysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `Images upscaled beyond natural resolution`,
        detail: `<a href="${url}">${url}</a>: ${upscaledImages.length} image(s) without srcset are displayed wider than their natural resolution supports at ${devicePixelRatio}× DPR, so they look blurry. Examples: ${examples}`,
      });
    }

    if (upscaledBackgrounds.length > 0) {
      const examples = upscaledBackgrounds
        .slice(0, 3)
        .map((b) => `${b.naturalWidth}px natural in a ${Math.round(b.elementWidth)}px element`)
        .join(', ');
      imageAnalysis.issues.push({
        severity: SEVERITY.LOW,
        message: `CSS background images upscaled beyond natural resolution`,
        detail: `<a href="${url}">${url}</a>: ${upscaledBackgrounds.length} background image(s) are stretched beyond their natural resolution at ${devicePixelRatio}× DPR. Examples: ${examples}`,
      });
    }

    // Generate summary issues
    if (imageAnalysis.totalImages >= THRESHOLDS.LAZY_LOAD_THRESHOLD && imageAnalysis.withLazyLoading === 0) {
      imageAnalysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `Some pages have many images but none use lazy loading`,
        detail: `<a href="${url}">${url}</a> has ${imageAnalysis.totalImages} images but none use lazy loading`,
      });
    }

    if (imageAnalysis.oversizedImages.length > 0) {
      // Report the count only. The raw image srcs were CDN-hash URLs that got
      // substring-truncated mid-string and, comma-joined into the detail, leaked
      // a trailing comma into each link and made the curated report mis-cluster
      // this single-page finding under a "Pages sharing this value" group.
      imageAnalysis.issues.push({
        severity: SEVERITY.HIGH,
        message: `Pages have image files larger than recommended`,
        detail: `<a href="${url}">${url}</a> has ${imageAnalysis.oversizedImages.length} image file(s) over ${Math.round(THRESHOLDS.IMAGE_SIZE_MAX / 1000)}KB each.`,
      });
    }

    if (imageAnalysis.totalImageSize > THRESHOLDS.TOTAL_IMAGE_SIZE_MAX) {
      imageAnalysis.issues.push({
        severity: SEVERITY.HIGH,
        message: `Some pages have excessive total image size`,
        detail: `<a href="${url}">${url}</a> total image size is ${Math.round(imageAnalysis.totalImageSize / 1000)}KB (recommended max: ${Math.round(THRESHOLDS.TOTAL_IMAGE_SIZE_MAX / 1000)}KB)`,
      });
    }

    if (imageAnalysis.legacyFormats > 0 && imageAnalysis.modernFormats === 0) {
      imageAnalysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `Pages serve images only as JPG/PNG instead of WebP/AVIF`,
        detail: `<a href="${url}">${url}</a> has ${imageAnalysis.legacyFormats} images all in older formats (JPG/PNG). Modern formats (WebP/AVIF) are typically 30–50% smaller for the same quality`,
      });
    }

    return imageAnalysis;
  }

  /**
   * Decodes CSS background images in-page to learn their natural size. Capped and
   * time-boxed so it stays well inside the analyzer timeout; returns what decoded in time.
   */
  private static async collectBackgrounds(chromePage: ChromePage): Promise<BackgroundImageInput[]> {
    return chromePage.evaluate(
      async ({ cap, perImageMs, totalMs }) => {
        const targets: { url: string; el: Element; size: string; repeat: string }[] = [];
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          if (targets.length >= cap) break;
          const style = getComputedStyle(el);
          const match = /url\(["']?([^"')]+)["']?\)/.exec(style.backgroundImage);
          if (!match) continue;
          targets.push({ url: match[1], el, size: style.backgroundSize, repeat: style.backgroundRepeat });
        }
        const decoded: BackgroundImageInput[] = [];
        const decodeOne = (t: (typeof targets)[number]) =>
          new Promise<void>((resolve) => {
            const image = new Image();
            const timer = setTimeout(resolve, perImageMs);
            image.onload = () => {
              clearTimeout(timer);
              const rect = t.el.getBoundingClientRect();
              decoded.push({
                url: image.src,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                elementWidth: rect.width,
                elementHeight: rect.height,
                backgroundSize: t.size,
                backgroundRepeat: t.repeat,
              });
              resolve();
            };
            image.onerror = () => {
              clearTimeout(timer);
              resolve();
            };
            image.src = t.url;
          });
        await Promise.race([
          Promise.all(targets.map(decodeOne)),
          new Promise((resolve) => setTimeout(resolve, totalMs)),
        ]);
        return decoded.slice();
      },
      { cap: BACKGROUND_SCAN_CAP, perImageMs: BACKGROUND_DECODE_TIMEOUT_MS, totalMs: BACKGROUND_TOTAL_BUDGET_MS },
    );
  }
}

export { ImageOptimizationAnalyzer };
