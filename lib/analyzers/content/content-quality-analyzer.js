const { THRESHOLDS } = require('../../constants');

class ContentQualityAnalyzer {
  static async analyzeContentQuality(chromePage, url, pageHtml) {
    const contentAnalysis = await chromePage.evaluate(({thresholds, htmlContent}) => {
      const analysis = {
        wordCount: 0,
        characterCount: 0,
        paragraphCount: 0,
        sentenceCount: 0,
        avgWordsPerSentence: 0,
        textToHtmlRatio: 0,
        readabilityScore: 0,
        keywords: {},
        topKeywords: [],
        contentScore: 100,
        issues: [],
      };

      // Helper: Calculate Flesch Reading Ease
      function calculateReadability(text, wordCount, sentenceCount) {
        if (wordCount === 0 || sentenceCount === 0) return 0;

        const syllables = text.split(/\s+/).reduce((count, word) => {
          return count + countSyllables(word);
        }, 0);

        const avgWordsPerSentence = wordCount / sentenceCount;
        const avgSyllablesPerWord = syllables / wordCount;

        // Flesch Reading Ease formula
        const score = 206.835 - (1.015 * avgWordsPerSentence) - (84.6 * avgSyllablesPerWord);
        return Math.max(0, Math.min(100, Math.round(score)));
      }

      // Helper: Count syllables in a word (approximation)
      function countSyllables(word) {
        word = word.toLowerCase().replace(/[^a-z]/g, '');
        if (word.length <= 3) return 1;

        const vowels = word.match(/[aeiouy]+/g);
        if (!vowels) return 1;

        let syllableCount = vowels.length;

        // Adjust for silent e
        if (word.endsWith('e')) syllableCount--;
        // Adjust for double vowels
        syllableCount -= (word.match(/[aeiouy]{2,}/g) || []).length * 0.5;

        return Math.max(1, Math.round(syllableCount));
      }

      // Extract main content text
      const mainContent = document.querySelector('main, article, [role="main"]') || document.body;

      // Remove script, style, nav, header, footer from analysis
      const contentClone = mainContent.cloneNode(true);
      const elementsToRemove = contentClone.querySelectorAll('script, style, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]');
      elementsToRemove.forEach(el => el.remove());

      const textContent = contentClone.textContent || '';
      const cleanText = textContent.replace(/\s+/g, ' ').trim();

      // Word count
      const words = cleanText.split(/\s+/).filter(word => word.length > 0);
      analysis.wordCount = words.length;
      analysis.characterCount = cleanText.length;

      // Paragraph count
      const paragraphs = contentClone.querySelectorAll('p');
      analysis.paragraphCount = paragraphs.length;

      // Sentence count
      const sentences = cleanText.split(/[.!?]+/).filter(s => s.trim().length > 10);
      analysis.sentenceCount = sentences.length;

      if (analysis.sentenceCount > 0) {
        analysis.avgWordsPerSentence = Math.round(analysis.wordCount / analysis.sentenceCount);
      }

      // Text-to-HTML ratio
      const htmlLength = htmlContent.length;
      const textLength = cleanText.length;
      analysis.textToHtmlRatio = htmlLength > 0 ? Math.round((textLength / htmlLength) * 100) : 0;

      // Readability score
      analysis.readabilityScore = calculateReadability(cleanText, analysis.wordCount, analysis.sentenceCount);

      // Keyword extraction (simple frequency analysis)
      const stopWords = new Set(['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take', 'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us', 'is', 'was', 'are', 'been', 'has', 'had', 'were', 'said', 'did', 'having', 'may', 'should', 'am', 'being', 'more']);

      words.forEach(word => {
        const cleanWord = word.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (cleanWord.length > 3 && !stopWords.has(cleanWord)) {
          analysis.keywords[cleanWord] = (analysis.keywords[cleanWord] || 0) + 1;
        }
      });

      // Get top 10 keywords
      analysis.topKeywords = Object.entries(analysis.keywords)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => ({
          word,
          count,
          density: ((count / analysis.wordCount) * 100).toFixed(2)
        }));

      // Check for keyword stuffing
      const maxKeywordDensity = analysis.topKeywords.length > 0 ?
        parseFloat(analysis.topKeywords[0].density) : 0;

      // Content scoring
      if (analysis.wordCount < thresholds.CONTENT_MIN) {
        analysis.issues.push(`Content is too short (${analysis.wordCount} words, minimum: ${thresholds.CONTENT_MIN})`);
        analysis.contentScore -= 20;
      } else if (analysis.wordCount < thresholds.CONTENT_RECOMMENDED) {
        analysis.issues.push(`Content could be longer (${analysis.wordCount} words, recommended: ${thresholds.CONTENT_RECOMMENDED})`);
        analysis.contentScore -= 10;
      }

      if (analysis.textToHtmlRatio < thresholds.TEXT_TO_HTML_RATIO_MIN) {
        analysis.issues.push(`Low text-to-HTML ratio (${analysis.textToHtmlRatio}%, minimum: ${thresholds.TEXT_TO_HTML_RATIO_MIN}%)`);
        analysis.contentScore -= 15;
      }

      if (analysis.paragraphCount < thresholds.PARAGRAPH_MIN) {
        analysis.issues.push(`Too few paragraphs (${analysis.paragraphCount}, minimum: ${thresholds.PARAGRAPH_MIN})`);
        analysis.contentScore -= 10;
      }

      if (analysis.readabilityScore < 30) {
        analysis.issues.push(`Content is very difficult to read (score: ${analysis.readabilityScore}/100)`);
        analysis.contentScore -= 15;
      } else if (analysis.readabilityScore < 50) {
        analysis.issues.push(`Content is difficult to read (score: ${analysis.readabilityScore}/100)`);
        analysis.contentScore -= 10;
      }

      if (analysis.avgWordsPerSentence > 25) {
        analysis.issues.push(`Sentences are too long (avg: ${analysis.avgWordsPerSentence} words, target: ~${thresholds.SENTENCE_AVG_WORDS})`);
        analysis.contentScore -= 5;
      }

      if (maxKeywordDensity > thresholds.KEYWORD_DENSITY_MAX) {
        analysis.issues.push(`Possible keyword stuffing detected (${analysis.topKeywords[0].word}: ${maxKeywordDensity}%)`);
        analysis.contentScore -= 20;
      }

      analysis.contentScore = Math.max(0, analysis.contentScore);

      return analysis;
    }, {thresholds: THRESHOLDS, htmlContent: pageHtml});

    return contentAnalysis;
  }
}

module.exports = { ContentQualityAnalyzer };
