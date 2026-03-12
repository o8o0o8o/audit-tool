import type { ParsedPage } from '../../types';

class ImageAnalyzer {
  static async extractImageAlts(parsedPage: ParsedPage) {
    const images: { alt: string | null; src: string }[] = [];

    for (const image of parsedPage.querySelectorAll('img')) {
      const alt = image.attributes.alt;
      const src = image.attributes.src || '';

      images.push({ alt: alt ?? null, src });
    }

    return images;
  }
}

export { ImageAnalyzer };
