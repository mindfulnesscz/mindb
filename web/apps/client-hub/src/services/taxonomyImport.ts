/**
 * Taxonomy JSON — barrel over ./taxonomy/*.
 *
 *   validate  parse + validate a document (pure; the import gate)
 *   build     produce a document from a client's live tags (pure) + browser download
 *   apply     write a validated document to a client (the only part that touches the DB)
 *
 * Split so the validation rules — which guard a destructive import — are testable without a
 * database or a DOM. See taxonomy/validate.test.ts.
 */

export {
  TAXONOMY_JSON_VERSION,
  parseTaxonomyJsonText,
  validateTaxonomyDocument,
  parseAndValidateTaxonomyJson,
  type TaxonomyDimension,
  type TaxonomyNodeInput,
  type TaxonomyDocument,
  type TaxonomyValidationResult,
} from './taxonomy/validate';

export {
  buildTaxonomyDocument,
  downloadTaxonomyJson,
  type TaxonomyExportTag,
} from './taxonomy/build';

export {
  importTaxonomyToClient,
  importTaxonomyJsonFile,
  type ImportTaxonomyOptions,
  type ImportTaxonomyResult,
} from './taxonomy/apply';
