const { SEVERITY, THRESHOLDS } = require('../../constants');

class ImageOptimizationAnalyzer {
  static async analyzeImageOptimization(chromePage, requests, url) {
    const imageAnalysis = {
      totalImages: 0,
      totalImageSize: 0,
      oversizedImages: [],
      modernFormats: 0,
      legacyFormats: 0,
      withLazyLoading: 0,
      withoutLazyLoading: 0,
      withoutAlt: 0,
      issues: [],
    };

    // Get all images with their properties
    const imageElements = await chromePage.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.map(img => ({
        src: img.src || img.getAttribute('src'),
        loading: img.loading, // 'lazy', 'eager', or undefined
        width: img.width,
        height: img.height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        alt: img.alt,
        displayWidth: img.getBoundingClientRect().width,
        displayHeight: img.getBoundingClientRect().height,
      }));
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
        const size = imgRequest.size || 0;

        imageAnalysis.totalImageSize += size;

        // Check image format
        const imgPath = img.src.toLowerCase().split('?')[0]; // strip query params
        if (imgPath.endsWith('.webp') || imgPath.endsWith('.avif')) {
          imageAnalysis.modernFormats++;
        } else if (imgPath.endsWith('.jpg') || imgPath.endsWith('.jpeg') || imgPath.endsWith('.png') || imgPath.endsWith('.gif')) {
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
      const oversizedSrcs = imageAnalysis.oversizedImages.slice(0, 3).map(i => i.src?.substring(0, 60)).join(', ');
      imageAnalysis.issues.push({
        severity: SEVERITY.HIGH,
        message: `Some pages have oversized images`,
        detail: `<a href="${url}">${url}</a> has ${imageAnalysis.oversizedImages.length} image(s) exceeding ${Math.round(THRESHOLDS.IMAGE_SIZE_MAX / 1000)}KB: ${oversizedSrcs}`,
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
        message: `Some pages use only legacy image formats`,
        detail: `<a href="${url}">${url}</a> has ${imageAnalysis.legacyFormats} images all in legacy formats (JPG/PNG). Consider WebP/AVIF for better compression`,
      });
    }

    return imageAnalysis;
  }
}

module.exports = { ImageOptimizationAnalyzer };
