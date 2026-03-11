import type { ChromePage } from '../../types';

class StructuredDataAnalyzer {
  static async analyzeStructuredData(page: ChromePage) {
    return await page.evaluate(() => {
      const result = {
        hasStructuredData: false,
        jsonLdSchemas: [] as Record<string, any>[],
        microdataItems: [] as Record<string, any>[],
        total: 0,
        validationErrors: [] as string[],
        validationWarnings: [] as string[],
      };

      // Schema validation rules for common types
      const schemaRules: Record<string, { required: string[]; recommended: string[] }> = {
        'Article': {
          required: ['headline', 'author', 'datePublished'],
          recommended: ['image', 'publisher', 'dateModified', 'description']
        },
        'NewsArticle': {
          required: ['headline', 'author', 'datePublished'],
          recommended: ['image', 'publisher', 'dateModified', 'description']
        },
        'BlogPosting': {
          required: ['headline', 'author', 'datePublished'],
          recommended: ['image', 'publisher', 'dateModified', 'description']
        },
        'Product': {
          required: ['name', 'description'],
          recommended: ['image', 'offers', 'aggregateRating', 'brand', 'sku']
        },
        'Organization': {
          required: ['name'],
          recommended: ['url', 'logo', 'contactPoint', 'sameAs', 'address']
        },
        'LocalBusiness': {
          required: ['name', 'address'],
          recommended: ['telephone', 'url', 'openingHours', 'image', 'priceRange']
        },
        'WebPage': {
          required: ['name'],
          recommended: ['description', 'url', 'breadcrumb']
        },
        'WebSite': {
          required: ['name', 'url'],
          recommended: ['description', 'potentialAction']
        },
        'BreadcrumbList': {
          required: ['itemListElement'],
          recommended: []
        },
        'Person': {
          required: ['name'],
          recommended: ['url', 'image', 'jobTitle', 'sameAs']
        },
        'Event': {
          required: ['name', 'startDate', 'location'],
          recommended: ['description', 'image', 'endDate', 'organizer', 'offers']
        },
        'VideoObject': {
          required: ['name', 'description', 'thumbnailUrl', 'uploadDate'],
          recommended: ['duration', 'contentUrl', 'embedUrl', 'publisher']
        },
        'ImageObject': {
          required: ['url'],
          recommended: ['name', 'caption', 'creator']
        },
        'Recipe': {
          required: ['name', 'recipeIngredient', 'recipeInstructions'],
          recommended: ['image', 'author', 'datePublished', 'description', 'prepTime', 'cookTime', 'nutrition']
        },
        'FAQPage': {
          required: ['mainEntity'],
          recommended: []
        },
        'HowTo': {
          required: ['name', 'step'],
          recommended: ['description', 'image', 'totalTime', 'supply', 'tool']
        }
      };

      // Helper function to validate a schema object
      const validateSchema = (schema: Record<string, any>, type: string) => {
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
      const getSchemaType = (schema: Record<string, any>) => {
        if (!schema['@type']) return null;
        return Array.isArray(schema['@type']) ? schema['@type'][0] : schema['@type'];
      };

      // Check for JSON-LD
      const jsonLdScripts = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      );

      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const schemas = Array.isArray(data) ? data : [data];

          for (const schema of schemas) {
            const type = getSchemaType(schema);

            if (type) {
              const schemaInfo: any = {
                type: type,
                context: schema['@context'] || 'unknown',
                raw: schema, // Store full schema for detailed analysis
              };

              // Validate the schema
              const validation = validateSchema(schema, type);
              if (validation) {
                if (validation.errors.length > 0) {

                  schemaInfo.errors = validation.errors;
                  result.validationErrors.push(...validation.errors.map(e => `${type}: ${e}`));
                }
                if (validation.warnings.length > 0) {

                  schemaInfo.warnings = validation.warnings;
                  result.validationWarnings.push(...validation.warnings.map(w => `${type}: ${w}`));
                }
              }

              result.jsonLdSchemas.push(schemaInfo);
            } else if (schema['@graph']) {
              // Handle @graph format (multiple schemas in one script)
              for (const graphItem of schema['@graph']) {
                const graphType = getSchemaType(graphItem);
                if (graphType) {
                  const graphSchemaInfo: any = {
                    type: graphType,
                    context: schema['@context'] || 'unknown',
                    raw: graphItem,
                  };

                  const validation = validateSchema(graphItem, graphType);
                  if (validation) {
                    if (validation.errors.length > 0) {
    
                      graphSchemaInfo.errors = validation.errors;
                      result.validationErrors.push(...validation.errors.map(e => `${graphType}: ${e}`));
                    }
                    if (validation.warnings.length > 0) {
    
                      graphSchemaInfo.warnings = validation.warnings;
                      result.validationWarnings.push(...validation.warnings.map(w => `${graphType}: ${w}`));
                    }
                  }

                  result.jsonLdSchemas.push(graphSchemaInfo);
                }
              }
            }
          }
        } catch (e) {
          result.jsonLdSchemas.push({
            type: 'invalid',
            error: 'Failed to parse JSON-LD: ' + (e as Record<string, any>).message,
          });
          result.validationErrors.push('Invalid JSON-LD syntax');
        }
      }

      // Check for Microdata
      const microdataItems = document.querySelectorAll('[itemscope]');
      for (const item of microdataItems) {
        const itemType = item.getAttribute('itemtype');
        if (itemType) {
          result.microdataItems.push({
            type: itemType.split('/').pop(),
            full: itemType,
          });
        }
      }

      result.total = result.jsonLdSchemas.length + result.microdataItems.length;
      result.hasStructuredData = result.total > 0;

      return result;
    });
  }
}

export { StructuredDataAnalyzer };