import type { ChromePage, ParsedPage } from '../../types';

interface JsonLdSchemaInfo {
  type: string;
  context?: string;
  raw?: Record<string, unknown>;
  error?: string;
  errors?: string[];
  warnings?: string[];
}

interface MicrodataItem {
  type: string | undefined;
  full: string;
}

class StructuredDataAnalyzer {
  static async analyzeStructuredData(page: ChromePage | null, parsedPage?: ParsedPage) {
    // Extract the raw JSON-LD script texts + microdata itemtypes from whichever
    // source is available; the browser path reads the live DOM, the no-playwright
    // path reads the parsed HTML. All parsing/validation then runs in Node via
    // the shared #buildResult (behavior-preserving — same output either way).
    let jsonLdTexts: string[] = [];
    let itemTypes: string[] = [];
    if (page) {
      const ex = await page.evaluate(() => ({
        jsonLdTexts: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(
          (s) => s.textContent ?? '',
        ),
        itemTypes: Array.from(document.querySelectorAll('[itemscope]'))
          .map((el) => el.getAttribute('itemtype') ?? '')
          .filter(Boolean),
      }));
      jsonLdTexts = ex.jsonLdTexts;
      itemTypes = ex.itemTypes;
    } else if (parsedPage) {
      jsonLdTexts = parsedPage.querySelectorAll('script[type="application/ld+json"]').map((s) => s.text ?? '');
      itemTypes = parsedPage
        .querySelectorAll('[itemscope]')
        .map((el) => el.getAttribute('itemtype') ?? '')
        .filter(Boolean);
    }
    return StructuredDataAnalyzer.#buildResult(jsonLdTexts, itemTypes);
  }

  /** Pure JSON-LD + microdata validation, shared by the browser and
   *  no-playwright paths. Operates only on the extracted strings — no DOM. */
  static #buildResult(jsonLdTexts: string[], itemTypes: string[]) {
      const result = {
        hasStructuredData: false,
        jsonLdSchemas: [] as JsonLdSchemaInfo[],
        microdataItems: [] as MicrodataItem[],
        total: 0,
        validationErrors: [] as string[],
        validationWarnings: [] as string[],
      };

      // Schema validation rules for common types
      const schemaRules: Record<string, { required: string[]; recommended: string[] }> = {
        Article: {
          required: ['headline', 'author', 'datePublished'],
          recommended: ['image', 'publisher', 'dateModified', 'description'],
        },
        NewsArticle: {
          required: ['headline', 'author', 'datePublished'],
          recommended: ['image', 'publisher', 'dateModified', 'description'],
        },
        BlogPosting: {
          required: ['headline', 'author', 'datePublished'],
          recommended: ['image', 'publisher', 'dateModified', 'description'],
        },
        Product: {
          required: ['name', 'description'],
          recommended: ['image', 'offers', 'aggregateRating', 'brand', 'sku'],
        },
        Organization: {
          required: ['name'],
          recommended: ['url', 'logo', 'contactPoint', 'sameAs', 'address'],
        },
        LocalBusiness: {
          required: ['name', 'address'],
          recommended: ['telephone', 'url', 'openingHours', 'image', 'priceRange'],
        },
        WebPage: {
          required: ['name'],
          recommended: ['description', 'url', 'breadcrumb'],
        },
        WebSite: {
          required: ['name', 'url'],
          recommended: ['description', 'potentialAction'],
        },
        BreadcrumbList: {
          required: ['itemListElement'],
          recommended: [],
        },
        Person: {
          required: ['name'],
          recommended: ['url', 'image', 'jobTitle', 'sameAs'],
        },
        Event: {
          required: ['name', 'startDate', 'location'],
          recommended: ['description', 'image', 'endDate', 'organizer', 'offers'],
        },
        VideoObject: {
          required: ['name', 'description', 'thumbnailUrl', 'uploadDate'],
          recommended: ['duration', 'contentUrl', 'embedUrl', 'publisher'],
        },
        ImageObject: {
          required: ['url'],
          recommended: ['name', 'caption', 'creator'],
        },
        Recipe: {
          required: ['name', 'recipeIngredient', 'recipeInstructions'],
          recommended: ['image', 'author', 'datePublished', 'description', 'prepTime', 'cookTime', 'nutrition'],
        },
        FAQPage: {
          required: ['mainEntity'],
          recommended: [],
        },
        HowTo: {
          required: ['name', 'step'],
          recommended: ['description', 'image', 'totalTime', 'supply', 'tool'],
        },
      };

      // Helper function to validate a schema object
      const validateSchema = (schema: Record<string, unknown>, type: string) => {
        const rules = schemaRules[type];
        if (!rules) return; // No validation rules for this type

        const errors = [];
        const warnings = [];

        // Check required fields
        for (const field of rules.required) {
          if (schema[field] == null) {
            errors.push(`Missing required field: ${field}`);
          }
        }

        // Check recommended fields
        for (const field of rules.recommended) {
          if (schema[field] == null) {
            warnings.push(`Missing recommended field: ${field}`);
          }
        }

        return { errors, warnings };
      };

      // Helper to get nested @type (handles array or string)
      const getSchemaType = (schema: Record<string, unknown>) => {
        if (!schema['@type']) return null;
        return Array.isArray(schema['@type']) ? schema['@type'][0] : schema['@type'];
      };

      // Check for JSON-LD (raw script texts passed in)
      for (const scriptText of jsonLdTexts) {
        try {
          const data = JSON.parse(scriptText) as Record<string, unknown> | Record<string, unknown>[];
          const schemas = Array.isArray(data) ? data : [data];

          for (const schema of schemas) {
            const type = getSchemaType(schema);

            if (type) {
              const schemaInfo: JsonLdSchemaInfo = {
                type: type,
                context: (schema['@context'] as string) || 'unknown',
                raw: schema, // Store full schema for detailed analysis
              };

              // Validate the schema
              const validation = validateSchema(schema, type);
              if (validation) {
                if (validation.errors.length > 0) {
                  schemaInfo.errors = validation.errors;
                  result.validationErrors.push(...validation.errors.map((e) => `${type}: ${e}`));
                }
                if (validation.warnings.length > 0) {
                  schemaInfo.warnings = validation.warnings;
                  result.validationWarnings.push(...validation.warnings.map((w) => `${type}: ${w}`));
                }
              }

              result.jsonLdSchemas.push(schemaInfo);
            } else if (schema['@graph']) {
              // Handle @graph format (multiple schemas in one script)
              for (const graphItem of schema['@graph'] as Record<string, unknown>[]) {
                const graphType = getSchemaType(graphItem);
                if (graphType) {
                  const graphSchemaInfo: JsonLdSchemaInfo = {
                    type: graphType,
                    context: (schema['@context'] as string) || 'unknown',
                    raw: graphItem,
                  };

                  const validation = validateSchema(graphItem, graphType);
                  if (validation) {
                    if (validation.errors.length > 0) {
                      graphSchemaInfo.errors = validation.errors;
                      result.validationErrors.push(...validation.errors.map((e) => `${graphType}: ${e}`));
                    }
                    if (validation.warnings.length > 0) {
                      graphSchemaInfo.warnings = validation.warnings;
                      result.validationWarnings.push(...validation.warnings.map((w) => `${graphType}: ${w}`));
                    }
                  }

                  result.jsonLdSchemas.push(graphSchemaInfo);
                }
              }
            }
          }
        } catch (e: unknown) {
          result.jsonLdSchemas.push({
            type: 'invalid',
            error: 'Failed to parse JSON-LD: ' + (e as Error).message,
          });
          result.validationErrors.push('Invalid JSON-LD syntax');
        }
      }

      // Check for Microdata (raw itemtype strings passed in)
      for (const itemType of itemTypes) {
        result.microdataItems.push({
          type: itemType.split('/').pop(),
          full: itemType,
        });
      }

      result.total = result.jsonLdSchemas.length + result.microdataItems.length;
      result.hasStructuredData = result.total > 0;

      return result;
  }
}

export { StructuredDataAnalyzer };
