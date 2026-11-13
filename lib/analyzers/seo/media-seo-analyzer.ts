/**
 * Media SEO Analyzer
 * Analyzes video and media content for SEO best practices
 */

import { SEVERITY } from '../../constants';
import type { ChromePage, ParsedPage, Issue, PageInfo } from '../../types';

interface NativeVideoInfo {
  type: 'native';
  src: string | null;
  sources: (string | null)[];
  hasPoster: boolean;
  poster: string | null;
  hasTitle: boolean;
  title: string | null;
  hasCaption: boolean;
  captionKind: string | null;
  autoplay: boolean;
  muted: boolean;
  /** Muted autoplay without controls: a silent background/UI clip, not content to caption or index. */
  decorative?: boolean;
}

interface EmbeddedVideoInfo {
  type: 'embedded';
  platform: string;
  src: string;
  hasTitle: boolean;
  title: string | null;
  hasCaption: boolean;
}

interface AudioInfo {
  src: string | null;
  hasTitle: boolean;
  hasTranscript: boolean;
}

class MediaSEOAnalyzer {
  /**
   * Analyze media SEO
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {Object} pageData - Page data (for structured data)
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const mediaData = {
      videos: [] as (NativeVideoInfo | EmbeddedVideoInfo)[],
      audios: [] as AudioInfo[],
      hasVideoSchema: false,
      videoSchemaValid: false,
      totalVideos: 0,
      totalAudios: 0,
      embeddedVideos: [] as EmbeddedVideoInfo[],
      nativeVideos: [] as NativeVideoInfo[],
      videosWithoutCaptions: 0,
      videosWithoutPoster: 0,
      videosWithoutTitle: 0,
      videoSchemaIssues: [] as string[],
    };

    // 1. Find native video elements
    const nativeVideos = await this.#analyzeNativeVideos(chromePage, parsedPage);
    mediaData.nativeVideos = nativeVideos;
    mediaData.totalVideos += nativeVideos.length;

    // 2. Find embedded videos (YouTube, Vimeo, etc.)
    const embeddedVideos = this.#findEmbeddedVideos(parsedPage);
    mediaData.embeddedVideos = embeddedVideos;
    mediaData.totalVideos += embeddedVideos.length;

    // 3. Find audio elements
    const audioElements = this.#findAudioElements(parsedPage);
    mediaData.audios = audioElements;
    mediaData.totalAudios = audioElements.length;

    // 4. Check for VideoObject schema
    const videoSchema = this.#checkVideoSchema(pageData);
    mediaData.hasVideoSchema = videoSchema.hasSchema;
    mediaData.videoSchemaValid = videoSchema.isValid;
    mediaData.videoSchemaIssues = videoSchema.issues;

    // 5. Count issues
    for (const video of [...nativeVideos, ...embeddedVideos] as (NativeVideoInfo | EmbeddedVideoInfo)[]) {
      const decorative = video.type === 'native' && !!video.decorative;
      if (!video.hasCaption && !decorative) mediaData.videosWithoutCaptions++;
      if ('hasPoster' in video && !video.hasPoster && video.type === 'native') mediaData.videosWithoutPoster++;
      if (!video.hasTitle && !decorative) mediaData.videosWithoutTitle++;
    }
    const contentVideos = mediaData.totalVideos - nativeVideos.filter((v) => v.decorative).length;

    // Generate issues

    // Videos without schema markup
    if (contentVideos > 0 && !mediaData.hasVideoSchema) {
      issues.push({
        message: 'Video content without VideoObject schema',
        detail: `<a href="${url}">${url}</a> has ${contentVideos} video(s) but no VideoObject structured data. Add schema markup for better search visibility and video rich results.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Invalid video schema
    if (mediaData.hasVideoSchema && !mediaData.videoSchemaValid) {
      issues.push({
        message: 'Invalid VideoObject schema',
        detail: `<a href="${url}">${url}</a> has VideoObject schema with issues: ${mediaData.videoSchemaIssues.join(', ')}`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Videos without captions/transcripts
    if (mediaData.videosWithoutCaptions > 0) {
      warnings.push({
        message: 'Videos without captions or transcripts',
        detail: `<a href="${url}">${url}</a> has ${mediaData.videosWithoutCaptions} video(s) without captions. Captions improve accessibility and SEO (text can be indexed).`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Native videos without poster
    if (mediaData.videosWithoutPoster > 0) {
      warnings.push({
        message: 'Videos without poster image',
        detail: `<a href="${url}">${url}</a> has ${mediaData.videosWithoutPoster} video(s) without poster attribute. Add poster images for better UX and thumbnail display.`,
        severity: SEVERITY.LOW,
      });
    }

    // Videos without accessible title
    if (mediaData.videosWithoutTitle > 0) {
      warnings.push({
        message: 'Videos without accessible title',
        detail: `<a href="${url}">${url}</a> has ${mediaData.videosWithoutTitle} video(s) without title or aria-label for screen readers.`,
        severity: SEVERITY.LOW,
      });
    }

    // Check for autoplay with sound (UX issue)
    const autoplayVideos = nativeVideos.filter((v: NativeVideoInfo) => v.autoplay && !v.muted);
    if (autoplayVideos.length > 0) {
      warnings.push({
        message: 'Autoplaying video with sound',
        detail: `<a href="${url}">${url}</a> has video(s) set to autoplay with sound. This creates poor UX and may be blocked by browsers.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, mediaData };
  }

  /**
   * Analyze native video elements
   * @private
   */
  static async #analyzeNativeVideos(chromePage: ChromePage, parsedPage: ParsedPage): Promise<NativeVideoInfo[]> {
    const videos: NativeVideoInfo[] = [];
    const videoElements = parsedPage.querySelectorAll('video');

    for (const video of videoElements) {
      const poster = video.getAttribute('poster');
      const src = video.getAttribute('src');
      const title = video.getAttribute('title') ?? video.getAttribute('aria-label');
      const autoplay = video.hasAttribute('autoplay');
      const muted = video.hasAttribute('muted');
      const decorative = autoplay && muted && !video.hasAttribute('controls');

      // Check for track elements (captions)
      const tracks = video.querySelectorAll('track');
      const captionTrack = Array.from(tracks).find(
        (t) => t.getAttribute('kind') === 'captions' || t.getAttribute('kind') === 'subtitles',
      );

      // Check for source elements
      const sources = video.querySelectorAll('source');
      const sourceUrls = Array.from(sources).map((s) => s.getAttribute('src') ?? null);

      videos.push({
        type: 'native',
        src: src ?? sourceUrls[0] ?? null,
        sources: sourceUrls,
        hasPoster: !!poster,
        poster: poster ?? null,
        hasTitle: !!title,
        title: title ?? null,
        hasCaption: !!captionTrack,
        captionKind: captionTrack?.getAttribute('kind') ?? null,
        autoplay,
        muted,
        decorative,
      });
    }

    return videos;
  }

  /**
   * Find embedded videos (YouTube, Vimeo, etc.)
   * @private
   */
  static #findEmbeddedVideos(parsedPage: ParsedPage): EmbeddedVideoInfo[] {
    const videos: EmbeddedVideoInfo[] = [];
    const iframes = parsedPage.querySelectorAll('iframe');

    const videoPatterns = [
      { pattern: /youtube\.com\/embed/i, platform: 'youtube' },
      { pattern: /youtu\.be/i, platform: 'youtube' },
      { pattern: /vimeo\.com/i, platform: 'vimeo' },
      { pattern: /wistia\.com/i, platform: 'wistia' },
      { pattern: /vidyard\.com/i, platform: 'vidyard' },
      { pattern: /dailymotion\.com/i, platform: 'dailymotion' },
      { pattern: /player\.vimeo\.com/i, platform: 'vimeo' },
    ];

    for (const iframe of iframes) {
      const src = iframe.getAttribute('src') ?? '';
      const title = iframe.getAttribute('title');
      const ariaLabel = iframe.getAttribute('aria-label');

      for (const { pattern, platform } of videoPatterns) {
        if (pattern.test(src)) {
          // YouTube embeds can have cc_load_policy for captions
          const hasCaption = src.includes('cc_load_policy=1') || src.includes('captions=1');

          videos.push({
            type: 'embedded',
            platform,
            src: src.substring(0, 150),
            hasTitle: !!(title ?? ariaLabel),
            title: title ?? ariaLabel ?? null,
            hasCaption, // Can't fully determine for embeds
          });
          break;
        }
      }
    }

    return videos;
  }

  /**
   * Find audio elements
   * @private
   */
  static #findAudioElements(parsedPage: ParsedPage): AudioInfo[] {
    const audios: AudioInfo[] = [];
    const audioElements = parsedPage.querySelectorAll('audio');

    for (const audio of audioElements) {
      const src = audio.getAttribute('src');
      const title = audio.getAttribute('title') ?? audio.getAttribute('aria-label');

      // Check for track elements (transcripts)
      const tracks = audio.querySelectorAll('track');
      const hasTranscript = tracks.length > 0;

      audios.push({
        src: src ?? null,
        hasTitle: !!title,
        hasTranscript,
      });
    }

    return audios;
  }

  /**
   * Check for VideoObject schema
   * @private
   */
  static #checkVideoSchema(pageData: PageInfo) {
    const result: { hasSchema: boolean; isValid: boolean; issues: string[] } = {
      hasSchema: false,
      isValid: false,
      issues: [],
    };

    const structuredData = pageData.structuredData;
    if (!structuredData?.jsonLdSchemas) {
      return result;
    }

    // Look for VideoObject in schemas
    for (const schemaInfo of structuredData.jsonLdSchemas) {
      const schema = schemaInfo.raw;
      if (!schema) continue;

      const type = schema['@type'];
      if (type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'))) {
        result.hasSchema = true;

        // Validate required fields
        const requiredFields = ['name', 'description', 'thumbnailUrl', 'uploadDate'];
        const recommendedFields = ['duration', 'contentUrl', 'embedUrl'];

        for (const field of requiredFields) {
          if (!schema[field]) {
            result.issues.push(`Missing required field: ${field}`);
          }
        }

        // Check for missing recommended fields
        for (const field of recommendedFields) {
          if (!schema[field]) {
            result.issues.push(`Missing recommended field: ${field}`);
          }
        }

        result.isValid = result.issues.filter((i) => i.includes('required')).length === 0;
        break;
      }
    }

    return result;
  }

  /**
   * Site-wide media SEO analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let pagesWithVideo = 0;
    let pagesWithVideoSchema = 0;
    let totalVideosWithoutCaptions = 0;

    for (const [_url, page] of Object.entries(pages)) {
      if ((page.mediaData?.totalVideos ?? 0) > 0) {
        pagesWithVideo++;

        if (page.mediaData?.hasVideoSchema) {
          pagesWithVideoSchema++;
        }

        totalVideosWithoutCaptions += page.mediaData?.videosWithoutCaptions ?? 0;
      }
    }

    if (pagesWithVideo > 0 && pagesWithVideoSchema < pagesWithVideo * 0.5) {
      issues.push({
        message: 'Most video pages lack VideoObject schema',
        detail: `Only ${pagesWithVideoSchema} of ${pagesWithVideo} pages with video have schema markup. Add VideoObject schema for video rich results.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (totalVideosWithoutCaptions > 3) {
      warnings.push({
        message: 'Videos across the site lack captions',
        detail: `${totalVideosWithoutCaptions} video(s) across the site lack captions. Adding captions improves accessibility (WCAG requirement) and allows search engines to index video content.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }
}

export { MediaSEOAnalyzer };
