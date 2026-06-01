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
              detail: `<a href="${url}">${url}</a>: Image ${img.src.substring(0, 80)} is ${img.naturalWidth}x${img.naturalHeight} but displayed as ${Math.round(img.displayWidth)}x${Math.round(img.displayHeight)}`,
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

    // Generate summary issues
    if (imageAnalysis.totalImages >= THRESHOLDS.LAZY_LOAD_THRESHOLD && imageAnalysis.withLazyLoading === 0) {
      imageAnalysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `Some pages have many images but none use lazy loading`,
        detail: `<a href="${url}">${url}</a> has ${imageAnalysis.totalImages} images but none use lazy loading`,
      });
    }

    if (imageAnalysis.oversizedImages.length > 0) {
      const oversizedSrcs = imageAnalysis.oversizedImages
        .slice(0, 3)
        .map((i) => i.src?.substring(0, 60))
        .join(', ');
      imageAnalysis.issues.push({
        severity: SEVERITY.HIGH,
        message: `Pages have image files larger than recommended`,
        detail: `<a href="${url}">${url}</a> has ${imageAnalysis.oversizedImages.length} image file(s) over ${Math.round(THRESHOLDS.IMAGE_SIZE_MAX / 1000)}KB each: ${oversizedSrcs}`,
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
}

export { ImageOptimizationAnalyzer };
