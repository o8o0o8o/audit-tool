/**
 * Advanced Schema Validator
 * Validates specific schema types for completeness and correctness
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

interface SchemaValidationResult {
  issues: Issue[];
  warnings: Issue[];
  valid: boolean;
}

// JSON-LD schemas are inherently dynamic; this recursive type allows property access
// without resorting to `any` while still permitting nested property chains.
interface SchemaObject {
  [key: string]: SchemaValue;
}
type SchemaValue = string | number | boolean | null | undefined | SchemaObject | SchemaValue[];
type SchemaValidator = (schema: SchemaObject, url: string) => SchemaValidationResult;

class AdvancedSchemaValidator {
  /**
   * Validate schema markup on a page
   * @param {Object} pageData - Page data with structuredData
   * @param {string} url - Page URL
   * @returns {Object} Validation results
   */
  static validate(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const schemaData = {
      types: [] as string[],
      validationResults: {} as Record<string, SchemaValidationResult>,
    };

    const schemas = pageData.structuredData?.jsonLdSchemas ?? [];
    if (schemas.length === 0) {
      return { issues, warnings, schemaData };
    }

    for (const schemaInfo of schemas) {
      const type = schemaInfo.type;
      const schema = schemaInfo.raw as SchemaObject | undefined;
      if (!type || !schema) continue;

      schemaData.types.push(type);

      // Validate based on schema type
      const validator = this.getValidator(type);
      if (validator) {
        const result = validator(schema, url);
        if (!schemaData.validationResults[type]) {
          schemaData.validationResults[type] = result;
        } else {
          // Merge with existing results for duplicate schema types
          schemaData.validationResults[type].issues.push(...result.issues);
          schemaData.validationResults[type].warnings.push(...result.warnings);
          schemaData.validationResults[type].valid = schemaData.validationResults[type].valid && result.valid;
        }

        issues.push(...result.issues);
        warnings.push(...result.warnings);
      }
    }

    return { issues, warnings, schemaData };
  }

  /**
   * Get validator function for schema type
   */
  static getValidator(type: string): SchemaValidator | undefined {
    const validators: Record<string, SchemaValidator> = {
      Article: this.validateArticle,
      NewsArticle: this.validateArticle,
      BlogPosting: this.validateArticle,
      Product: this.validateProduct,
      FAQPage: this.validateFAQ,
      HowTo: this.validateHowTo,
      BreadcrumbList: this.validateBreadcrumb,
      LocalBusiness: this.validateLocalBusiness,
      Organization: this.validateOrganization,
      Person: this.validatePerson,
      Review: this.validateReview,
      Event: this.validateEvent,
      Recipe: this.validateRecipe,
      VideoObject: this.validateVideo,
      WebPage: this.validateWebPage,
    };

    return validators[type];
  }

  /**
   * Validate Article schema
   */
  static validateArticle(schema: SchemaObject, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const required = ['headline', 'author', 'datePublished'];
    const recommended = ['dateModified', 'image', 'publisher', 'description'];

    for (const field of required) {
      if (!schema[field]) {
        issues.push({
          message: `Article schema missing required field: ${field}`,
          detail: `<a href="${url}">${url}</a> - Add ${field} to Article schema for rich results`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    for (const field of recommended) {
      if (!schema[field]) {
        warnings.push({
          message: `Article schema missing recommended field: ${field}`,
          detail: `<a href="${url}">${url}</a> - Consider adding ${field} for better rich results`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Validate headline length
    const headline = schema.headline as string | undefined;
    if (headline && headline.length > 110) {
      warnings.push({
        message: 'Article headline too long for rich results',
        detail: `Headline is ${headline.length} chars (max 110 recommended)`,
        severity: SEVERITY.LOW,
      });
    }

    // Validate image
    if (schema.image) {
      const images = Array.isArray(schema.image) ? schema.image : [schema.image];
      const hasValidImage = images.some((img: SchemaValue) => {
        const imgUrl = typeof img === 'string' ? img : (img as SchemaObject)?.url;
        return typeof imgUrl === 'string' && imgUrl.startsWith('http');
      });
      if (!hasValidImage) {
        warnings.push({
          message: 'Article image URL may be invalid',
          detail: 'Image should be a full URL starting with http(s)',
          severity: SEVERITY.LOW,
        });
      }
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate Product schema
   */
  static validateProduct(schema: SchemaObject, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const required = ['name'];
    for (const field of required) {
      if (!schema[field]) {
        issues.push({
          message: `Product schema missing required field: ${field}`,
          detail: `<a href="${url}">${url}</a>`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check offers (critical for e-commerce)
    if (!schema.offers && !schema.offer) {
      issues.push({
        message: 'Product schema missing offers/pricing information',
        detail: `Products without pricing won't show rich results. <a href="${url}">${url}</a>`,
        severity: SEVERITY.HIGH,
      });
    } else {
      const offers = schema.offers ?? schema.offer;
      const offerList = Array.isArray(offers) ? offers : [offers];

      for (const offerRaw of offerList) {
        const offer = offerRaw as SchemaObject;
        if (offer.price == null && !offer.priceRange) {
          warnings.push({
            message: 'Product offer missing price',
            detail: 'Add price or priceRange to offers',
            severity: SEVERITY.MEDIUM,
          });
        }
        if (!offer.priceCurrency) {
          warnings.push({
            message: 'Product offer missing priceCurrency',
            detail: 'Add priceCurrency (e.g., USD, EUR) to offers',
            severity: SEVERITY.LOW,
          });
        }
        if (!offer.availability) {
          warnings.push({
            message: 'Product offer missing availability',
            detail: 'Add availability status (InStock, OutOfStock, etc.)',
            severity: SEVERITY.LOW,
          });
        }
      }
    }

    // Check reviews/ratings
    if (!schema.aggregateRating && !schema.review) {
      warnings.push({
        message: 'Product schema lacks reviews/ratings',
        detail: 'Products with ratings get better rich results visibility',
        severity: SEVERITY.LOW,
      });
    }

    if (schema.aggregateRating) {
      const rating = schema.aggregateRating as SchemaObject;
      if (rating.ratingValue == null || !rating.reviewCount) {
        warnings.push({
          message: 'Incomplete aggregateRating',
          detail: 'aggregateRating should include ratingValue and reviewCount',
          severity: SEVERITY.LOW,
        });
      }
      const worstRating = Number(rating.worstRating) || 1;
      const bestRating = Number(rating.bestRating) || 5;
      const ratingValue = Number(rating.ratingValue);
      if (rating.ratingValue != null && (ratingValue < worstRating || ratingValue > bestRating)) {
        issues.push({
          message: 'Invalid rating value',
          detail: `Rating ${rating.ratingValue} should be between ${worstRating} and ${bestRating}`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate FAQ schema
   */
  static validateFAQ(schema: SchemaObject, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    if (!schema.mainEntity || !Array.isArray(schema.mainEntity)) {
      issues.push({
        message: 'FAQPage missing mainEntity array',
        detail: `FAQPage requires mainEntity with Question items. <a href="${url}">${url}</a>`,
        severity: SEVERITY.HIGH,
      });
      return { issues, warnings, valid: false };
    }

    const questions = schema.mainEntity;

    if (questions.length === 0) {
      issues.push({
        message: 'FAQPage has no questions',
        detail: 'Add at least one Question to mainEntity',
        severity: SEVERITY.HIGH,
      });
    }

    if (questions.length > 10) {
      warnings.push({
        message: 'FAQPage has many questions',
        detail: `${questions.length} questions found. Google may only show first few in rich results`,
        severity: SEVERITY.LOW,
      });
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i] as SchemaObject;

      if (q['@type'] !== 'Question') {
        issues.push({
          message: `FAQ item ${i + 1} is not type Question`,
          detail: 'Each mainEntity item must be @type: Question',
          severity: SEVERITY.MEDIUM,
        });
      }

      if (!q.name) {
        issues.push({
          message: `FAQ Question ${i + 1} missing name (question text)`,
          detail: 'Each Question must have a name property',
          severity: SEVERITY.MEDIUM,
        });
      }

      if (!q.acceptedAnswer) {
        issues.push({
          message: `FAQ Question ${i + 1} missing acceptedAnswer`,
          detail: 'Each Question must have an acceptedAnswer',
          severity: SEVERITY.MEDIUM,
        });
      } else if (!(q.acceptedAnswer as SchemaObject).text) {
        issues.push({
          message: `FAQ Question ${i + 1} answer missing text`,
          detail: 'acceptedAnswer must have a text property',
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate HowTo schema
   */
  static validateHowTo(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    if (!schema.name) {
      issues.push({
        message: 'HowTo missing name',
        detail: 'HowTo schema requires a name (title)',
        severity: SEVERITY.MEDIUM,
      });
    }

    if (!schema.step || !Array.isArray(schema.step)) {
      issues.push({
        message: 'HowTo missing steps',
        detail: 'HowTo requires step array with HowToStep items',
        severity: SEVERITY.HIGH,
      });
      return { issues, warnings, valid: false };
    }

    const steps = schema.step;

    if (steps.length < 2) {
      warnings.push({
        message: 'HowTo has very few steps',
        detail: 'Consider adding more detailed steps for better rich results',
        severity: SEVERITY.LOW,
      });
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as SchemaObject;

      if (!step.name && !step.text) {
        issues.push({
          message: `HowTo step ${i + 1} missing content`,
          detail: 'Each step needs name or text',
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Recommended fields
    if (!schema.totalTime && !schema.estimatedCost) {
      warnings.push({
        message: 'HowTo missing time/cost estimates',
        detail: 'Adding totalTime or estimatedCost improves rich results',
        severity: SEVERITY.LOW,
      });
    }

    if (!schema.image) {
      warnings.push({
        message: 'HowTo missing image',
        detail: 'Images significantly improve HowTo rich results visibility',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate BreadcrumbList schema
   */
  static validateBreadcrumb(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    if (!schema.itemListElement || !Array.isArray(schema.itemListElement)) {
      issues.push({
        message: 'BreadcrumbList missing itemListElement',
        detail: 'BreadcrumbList requires itemListElement array',
        severity: SEVERITY.MEDIUM,
      });
      return { issues, warnings, valid: false };
    }

    const items = schema.itemListElement;

    if (items.length < 2) {
      warnings.push({
        message: 'BreadcrumbList has only one item',
        detail: 'Breadcrumbs typically have at least 2 levels',
        severity: SEVERITY.LOW,
      });
    }

    // Check position sequence
    let expectedPosition = 1;
    for (const itemRaw of items) {
      const item = itemRaw as SchemaObject;
      if (!item.position) {
        issues.push({
          message: 'Breadcrumb item missing position',
          detail: 'Each ListItem needs a position number',
          severity: SEVERITY.MEDIUM,
        });
      } else if (item.position !== expectedPosition) {
        warnings.push({
          message: 'Breadcrumb positions not sequential',
          detail: `Expected position ${expectedPosition}, got ${item.position}`,
          severity: SEVERITY.LOW,
        });
      }

      if (!item.name && !(item.item as SchemaObject | undefined)?.name) {
        issues.push({
          message: 'Breadcrumb item missing name',
          detail: 'Each breadcrumb needs a name',
          severity: SEVERITY.MEDIUM,
        });
      }

      expectedPosition++;
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate LocalBusiness schema
   */
  static validateLocalBusiness(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const required = ['name', 'address'];
    const recommended = ['telephone', 'openingHours', 'geo', 'image', 'priceRange'];

    for (const field of required) {
      if (!schema[field]) {
        issues.push({
          message: `LocalBusiness missing ${field}`,
          detail: `${field} is required for local business rich results`,
          severity: SEVERITY.HIGH,
        });
      }
    }

    for (const field of recommended) {
      if (!schema[field]) {
        warnings.push({
          message: `LocalBusiness missing recommended: ${field}`,
          detail: `Adding ${field} improves local SEO visibility`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Validate address
    if (schema.address) {
      const addr = schema.address as SchemaObject;
      if (!addr.streetAddress || !addr.addressLocality || !addr.addressCountry) {
        warnings.push({
          message: 'LocalBusiness address incomplete',
          detail: 'Include streetAddress, addressLocality, and addressCountry',
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Validate geo coordinates
    if (schema.geo) {
      const geo = schema.geo as SchemaObject;
      if (!geo.latitude || !geo.longitude) {
        warnings.push({
          message: 'LocalBusiness geo coordinates incomplete',
          detail: 'Include both latitude and longitude',
          severity: SEVERITY.LOW,
        });
      }
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate Organization schema
   */
  static validateOrganization(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    if (!schema.name) {
      issues.push({
        message: 'Organization missing name',
        detail: 'Organization schema requires name',
        severity: SEVERITY.MEDIUM,
      });
    }

    if (!schema.logo) {
      warnings.push({
        message: 'Organization missing logo',
        detail: 'Adding logo improves brand visibility in search',
        severity: SEVERITY.LOW,
      });
    }

    if (!schema.url) {
      warnings.push({
        message: 'Organization missing url',
        detail: 'Add official website URL',
        severity: SEVERITY.LOW,
      });
    }

    if (!schema.sameAs || !Array.isArray(schema.sameAs)) {
      warnings.push({
        message: 'Organization missing social profiles (sameAs)',
        detail: 'Link social media profiles via sameAs array',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate Person schema
   */
  static validatePerson(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    if (!schema.name) {
      issues.push({
        message: 'Person schema missing name',
        detail: 'Person schema requires name',
        severity: SEVERITY.MEDIUM,
      });
    }

    const recommended = ['image', 'jobTitle', 'worksFor', 'sameAs'];
    for (const field of recommended) {
      if (!schema[field]) {
        warnings.push({
          message: `Person missing recommended: ${field}`,
          detail: `Adding ${field} improves knowledge panel chances`,
          severity: SEVERITY.LOW,
        });
      }
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate Review schema
   */
  static validateReview(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    if (!schema.reviewRating) {
      issues.push({
        message: 'Review missing reviewRating',
        detail: 'Reviews require a rating',
        severity: SEVERITY.MEDIUM,
      });
    }

    if (!schema.author) {
      issues.push({
        message: 'Review missing author',
        detail: 'Reviews should have an author',
        severity: SEVERITY.MEDIUM,
      });
    }

    if (!schema.itemReviewed) {
      warnings.push({
        message: 'Review missing itemReviewed',
        detail: 'Specify what is being reviewed',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate Event schema
   */
  static validateEvent(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const required = ['name', 'startDate', 'location'];

    for (const field of required) {
      if (!schema[field]) {
        issues.push({
          message: `Event missing required: ${field}`,
          detail: `Events require ${field} for rich results`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Validate date
    if (schema.startDate) {
      const startDate = new Date(schema.startDate as string | number);
      if (isNaN(startDate.getTime())) {
        issues.push({
          message: 'Event has invalid startDate format',
          detail: 'Use ISO 8601 date format',
          severity: SEVERITY.MEDIUM,
        });
      } else if (startDate < new Date()) {
        warnings.push({
          message: 'Event startDate is in the past',
          detail: 'Past events may not show in rich results',
          severity: SEVERITY.LOW,
        });
      }
    }

    if (!schema.image) {
      warnings.push({
        message: 'Event missing image',
        detail: 'Events with images get better visibility',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate Recipe schema
   */
  static validateRecipe(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const required = ['name', 'image'];
    const recommended = ['recipeIngredient', 'recipeInstructions', 'prepTime', 'cookTime', 'nutrition'];

    for (const field of required) {
      if (!schema[field]) {
        issues.push({
          message: `Recipe missing required: ${field}`,
          detail: `Recipes require ${field}`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    for (const field of recommended) {
      if (!schema[field]) {
        warnings.push({
          message: `Recipe missing recommended: ${field}`,
          detail: `Adding ${field} improves recipe rich results`,
          severity: SEVERITY.LOW,
        });
      }
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate VideoObject schema
   */
  static validateVideo(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const required = ['name', 'description', 'thumbnailUrl', 'uploadDate'];

    for (const field of required) {
      if (!schema[field]) {
        issues.push({
          message: `VideoObject missing required: ${field}`,
          detail: `Videos require ${field} for rich results`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    if (!schema.contentUrl && !schema.embedUrl) {
      issues.push({
        message: 'VideoObject missing video URL',
        detail: 'Provide contentUrl or embedUrl',
        severity: SEVERITY.MEDIUM,
      });
    }

    if (!schema.duration) {
      warnings.push({
        message: 'VideoObject missing duration',
        detail: 'Adding duration improves video rich results',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, valid: issues.length === 0 };
  }

  /**
   * Validate WebPage schema
   */
  static validateWebPage(schema: SchemaObject, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    if (!schema.name && !schema.headline) {
      warnings.push({
        message: 'WebPage missing name/headline',
        detail: 'Add name or headline to WebPage schema',
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, valid: issues.length === 0 };
  }
}

export { AdvancedSchemaValidator };
