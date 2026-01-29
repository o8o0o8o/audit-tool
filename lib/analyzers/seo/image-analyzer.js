class ImageAnalyzer {
  static async extractImageAlts(parsedPage) {
    const images = [];

    for (const image of parsedPage.querySelectorAll("img")) {
      const alt = image.attributes.alt;

      if (alt) {
        images.push(alt);
      }
    }

    return images;
  }
}

module.exports = { ImageAnalyzer };
