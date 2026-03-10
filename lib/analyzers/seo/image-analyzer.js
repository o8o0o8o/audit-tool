class ImageAnalyzer {
  static async extractImageAlts(parsedPage) {
    const images = [];

    for (const image of parsedPage.querySelectorAll("img")) {
      const alt = image.attributes.alt;
      const src = image.attributes.src || '';

      images.push({ alt: alt ?? null, src });
    }

    return images;
  }
}

module.exports = { ImageAnalyzer };
