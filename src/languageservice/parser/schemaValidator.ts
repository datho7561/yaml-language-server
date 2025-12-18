/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JSONSchema, JSONSchemaRef } from '../jsonSchema';
import { isNumber, equals, isString, isDefined, isBoolean, isIterable } from '../utils/objects';
import { getSchemaTypeName } from '../utils/schemaUtils';
import { ASTNode, ObjectASTNode, ArrayASTNode, NumberASTNode, StringASTNode, PropertyASTNode } from '../jsonASTTypes';
import { ErrorCode } from 'vscode-json-languageservice';
import * as l10n from '@vscode/l10n';
import { URI } from 'vscode-uri';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { safeCreateUnicodeRegExp } from '../utils/strings';
import { FilePatternAssociation } from '../services/yamlSchemaService';
import { floatSafeRemainder } from '../utils/math';
import {
  ValidationResult,
  asSchema,
  getNodeValue,
  ISchemaCollector,
  NoOpSchemaCollector,
  ProblemType,
  getWarningMessage,
  IProblem,
  formats,
  YAML_SCHEMA_PREFIX,
  YAML_SOURCE,
} from './jsonParser07';

export interface Options {
  isKubernetes: boolean;
  disableAdditionalProperties?: boolean;
  uri?: string;
  callFromAutoComplete?: boolean;
}

/**
 * Abstract base class for JSON Schema validators.
 * Each schema version (draft-07, 2019-09, 2020-12) has its own implementation.
 */
export abstract class SchemaValidator {
  protected originalSchema: JSONSchema;
  protected options: Options;

  /**
   * Validates a node against a schema
   */
  public validate(
    node: ASTNode,
    schema: JSONSchema,
    originalSchema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector,
    options: Options
  ): void {
    this.originalSchema = originalSchema;
    this.options = options;

    if (!node) {
      return;
    }

    // schema should be an Object
    if (typeof schema !== 'object') {
      return;
    }

    if (!schema.url) {
      schema.url = originalSchema.url;
    }

    schema.closestTitle = schema.title || originalSchema.closestTitle;

    switch (node.type) {
      case 'object':
        this.validateObjectNode(node as ObjectASTNode, schema, validationResult, matchingSchemas);
        break;
      case 'array':
        this.validateArrayNode(node as ArrayASTNode, schema, validationResult, matchingSchemas);
        break;
      case 'string':
        this.validateStringNode(node as StringASTNode, schema, validationResult);
        break;
      case 'number':
        this.validateNumberNode(node as NumberASTNode, schema, validationResult);
        break;
      case 'property':
        return this.validate(node['valueNode'], schema, schema, validationResult, matchingSchemas, options);
    }
    this.validateNode(node, schema, originalSchema, validationResult, matchingSchemas, options);
    matchingSchemas.add({ node: node, schema: schema });
  }

  /**
   * Abstract method for array validation - each schema version implements this differently
   */
  protected abstract validateArrayNode(
    node: ArrayASTNode,
    schema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector
  ): void;

  /**
   * Abstract method for object validation - each schema version implements this differently
   */
  protected abstract validateObjectNode(
    node: ObjectASTNode,
    schema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector
  ): void;

  /**
   * Common validation logic for number nodes (shared across all versions)
   */
  protected validateNumberNode(node: NumberASTNode, schema: JSONSchema, validationResult: ValidationResult): void {
    const val = node.value;

    if (isNumber(schema.multipleOf)) {
      if (floatSafeRemainder(val, schema.multipleOf) !== 0) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: l10n.t('multipleOfWarning', schema.multipleOf),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        });
      }
    }
    function getExclusiveLimit(limit: number | undefined, exclusive: boolean | number | undefined): number | undefined {
      if (isNumber(exclusive)) {
        return exclusive;
      }
      if (isBoolean(exclusive) && exclusive) {
        return limit;
      }
      return undefined;
    }
    function getLimit(limit: number | undefined, exclusive: boolean | number | undefined): number | undefined {
      if (!isBoolean(exclusive) || !exclusive) {
        return limit;
      }
      return undefined;
    }
    const exclusiveMinimum = getExclusiveLimit(schema.minimum, schema.exclusiveMinimum);
    if (isNumber(exclusiveMinimum) && val <= exclusiveMinimum) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: l10n.t('exclusiveMinimumWarning', exclusiveMinimum),
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
    }
    const exclusiveMaximum = getExclusiveLimit(schema.maximum, schema.exclusiveMaximum);
    if (isNumber(exclusiveMaximum) && val >= exclusiveMaximum) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: l10n.t('exclusiveMaximumWarning', exclusiveMaximum),
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
    }
    const minimum = getLimit(schema.minimum, schema.exclusiveMinimum);
    if (isNumber(minimum) && val < minimum) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: l10n.t('minimumWarning', minimum),
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
    }
    const maximum = getLimit(schema.maximum, schema.exclusiveMaximum);
    if (isNumber(maximum) && val > maximum) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: l10n.t('maximumWarning', maximum),
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
    }
  }

  /**
   * Common validation logic for string nodes (shared across all versions)
   */
  protected validateStringNode(node: StringASTNode, schema: JSONSchema, validationResult: ValidationResult): void {
    if (isNumber(schema.minLength) && node.value.length < schema.minLength) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: l10n.t('minLengthWarning', schema.minLength),
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
    }

    if (isNumber(schema.maxLength) && node.value.length > schema.maxLength) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: l10n.t('maxLengthWarning', schema.maxLength),
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
    }

    if (isString(schema.pattern)) {
      const regex = safeCreateUnicodeRegExp(schema.pattern);
      if (!regex.test(node.value)) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: schema.patternErrorMessage || schema.errorMessage || l10n.t('patternWarning', schema.pattern),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        });
      }
    }

    if (schema.format) {
      switch (schema.format) {
        case 'uri':
        case 'uri-reference':
          {
            let errorMessage;
            if (!node.value) {
              errorMessage = l10n.t('uriEmpty');
            } else {
              try {
                const uri = URI.parse(node.value);
                if (!uri.scheme && schema.format === 'uri') {
                  errorMessage = l10n.t('uriSchemeMissing');
                }
              } catch (e) {
                errorMessage = e.message;
              }
            }
            if (errorMessage) {
              validationResult.problems.push({
                location: { offset: node.offset, length: node.length },
                severity: DiagnosticSeverity.Warning,
                message: schema.patternErrorMessage || schema.errorMessage || l10n.t('uriFormatWarning', errorMessage),
                source: this.getSchemaSource(schema),
                schemaUri: this.getSchemaUri(schema),
              });
            }
          }
          break;
        case 'color-hex':
        case 'date-time':
        case 'date':
        case 'time':
        case 'email':
        case 'ipv4':
        case 'ipv6':
          {
            const format = formats[schema.format];
            if (!node.value || !format.pattern.test(node.value)) {
              validationResult.problems.push({
                location: { offset: node.offset, length: node.length },
                severity: DiagnosticSeverity.Warning,
                message: schema.patternErrorMessage || schema.errorMessage || l10n.t(format.errorMessage),
                source: this.getSchemaSource(schema),
                schemaUri: this.getSchemaUri(schema),
              });
            }
          }
          break;
        default:
      }
    }
  }

  /**
   * Common validation logic for node-level constraints (shared across all versions)
   */
  protected validateNode(
    node: ASTNode,
    schema: JSONSchema,
    originalSchema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector,
    options: Options
  ): void {
    const { isKubernetes, callFromAutoComplete } = options;
    function matchesType(type: string): boolean {
      return node.type === type || (type === 'integer' && node.type === 'number' && node['isInteger']);
    }

    if (Array.isArray(schema.type)) {
      if (!schema.type.some(matchesType)) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: schema.errorMessage || l10n.t('typeArrayMismatchWarning', (<string[]>schema.type).join(', ')),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        });
      }
    } else if (schema.type) {
      if (!matchesType(schema.type)) {
        //get more specific name than just object
        const schemaType = schema.type === 'object' ? getSchemaTypeName(schema) : schema.type;
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: schema.errorMessage || getWarningMessage(ProblemType.typeMismatchWarning, [schemaType]),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
          problemType: ProblemType.typeMismatchWarning,
          problemArgs: [schemaType],
        });
      }
    }
    if (Array.isArray(schema.allOf)) {
      for (const subSchemaRef of schema.allOf) {
        this.validate(node, asSchema(subSchemaRef), schema, validationResult, matchingSchemas, options);
      }
    }
    const notSchema = asSchema(schema.not);
    if (notSchema) {
      const subValidationResult = new ValidationResult(isKubernetes);
      const subMatchingSchemas = matchingSchemas.newSub();
      this.validate(node, notSchema, schema, subValidationResult, subMatchingSchemas, options);
      if (!subValidationResult.hasProblems()) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: l10n.t('notSchemaWarning'),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        });
      }
      for (const ms of subMatchingSchemas.schemas) {
        ms.inverted = !ms.inverted;
        matchingSchemas.add(ms);
      }
    }

    const testAlternatives = (alternatives: JSONSchemaRef[], maxOneMatch: boolean): number => {
      const matches = [];
      const subMatches = [];
      const noPropertyMatches = [];
      // remember the best match that is used for error messages
      let bestMatch: {
        schema: JSONSchema;
        validationResult: ValidationResult;
        matchingSchemas: ISchemaCollector;
      } = null;
      for (const subSchemaRef of alternatives) {
        const subSchema = { ...asSchema(subSchemaRef) };
        const subValidationResult = new ValidationResult(isKubernetes);
        const subMatchingSchemas = matchingSchemas.newSub();
        this.validate(node, subSchema, schema, subValidationResult, subMatchingSchemas, options);
        if (!subValidationResult.hasProblems() || callFromAutoComplete) {
          matches.push(subSchema);
          subMatches.push(subSchema);
          if (subValidationResult.propertiesMatches === 0) {
            noPropertyMatches.push(subSchema);
          }
          if (subSchema.format) {
            subMatches.pop();
          }
        }
        if (!bestMatch) {
          bestMatch = {
            schema: subSchema,
            validationResult: subValidationResult,
            matchingSchemas: subMatchingSchemas,
          };
        } else if (isKubernetes) {
          bestMatch = this.alternativeComparison(subValidationResult, bestMatch, subSchema, subMatchingSchemas);
        } else {
          bestMatch = this.genericComparison(node, maxOneMatch, subValidationResult, bestMatch, subSchema, subMatchingSchemas);
        }
      }

      if (subMatches.length > 1 && (subMatches.length > 1 || noPropertyMatches.length === 0) && maxOneMatch) {
        validationResult.problems.push({
          location: { offset: node.offset, length: 1 },
          severity: DiagnosticSeverity.Warning,
          message: l10n.t('oneOfWarning'),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        });
      }
      if (bestMatch !== null) {
        validationResult.merge(bestMatch.validationResult);
        validationResult.propertiesMatches += bestMatch.validationResult.propertiesMatches;
        validationResult.propertiesValueMatches += bestMatch.validationResult.propertiesValueMatches;
        validationResult.enumValueMatch = validationResult.enumValueMatch || bestMatch.validationResult.enumValueMatch;
        if (bestMatch.validationResult.enumValues?.length) {
          validationResult.enumValues = (validationResult.enumValues || []).concat(bestMatch.validationResult.enumValues);
        }
        matchingSchemas.merge(bestMatch.matchingSchemas);
      }
      return matches.length;
    };
    if (Array.isArray(schema.anyOf)) {
      testAlternatives(schema.anyOf, false);
    }
    if (Array.isArray(schema.oneOf)) {
      testAlternatives(schema.oneOf, true);
    }

    const testBranch = (schema: JSONSchemaRef, originalSchema: JSONSchema): void => {
      const subValidationResult = new ValidationResult(isKubernetes);
      const subMatchingSchemas = matchingSchemas.newSub();

      this.validate(node, asSchema(schema), originalSchema, subValidationResult, subMatchingSchemas, options);

      validationResult.merge(subValidationResult);
      validationResult.propertiesMatches += subValidationResult.propertiesMatches;
      validationResult.propertiesValueMatches += subValidationResult.propertiesValueMatches;
      matchingSchemas.merge(subMatchingSchemas);
    };

    const testCondition = (
      ifSchema: JSONSchemaRef,
      originalSchema: JSONSchema,
      thenSchema?: JSONSchemaRef,
      elseSchema?: JSONSchemaRef
    ): void => {
      const subSchema = asSchema(ifSchema);
      const subValidationResult = new ValidationResult(isKubernetes);
      const subMatchingSchemas = matchingSchemas.newSub();

      this.validate(node, subSchema, originalSchema, subValidationResult, subMatchingSchemas, options);
      matchingSchemas.merge(subMatchingSchemas);

      const { filePatternAssociation } = subSchema;
      if (filePatternAssociation) {
        const association = new FilePatternAssociation(filePatternAssociation);
        if (!association.matchesPattern(options.uri)) {
          subValidationResult.problems.push({
            location: { offset: node.offset, length: node.length },
            severity: DiagnosticSeverity.Warning,
            message: l10n.t('ifFilePatternAssociation', filePatternAssociation, options.uri),
            source: this.getSchemaSource(schema),
            schemaUri: this.getSchemaUri(schema),
          });
          // don't want to expose the error up to code-completion results
          // validationResult.merge(subValidationResult);
        }
      }

      if (!subValidationResult.hasProblems()) {
        if (thenSchema) {
          testBranch(thenSchema, originalSchema);
        }
      } else if (elseSchema) {
        testBranch(elseSchema, originalSchema);
      }
    };

    const ifSchema = asSchema(schema.if);
    if (ifSchema) {
      testCondition(ifSchema, schema, asSchema(schema.then), asSchema(schema.else));
    }

    if (Array.isArray(schema.enum)) {
      const val = getNodeValue(node);
      let enumValueMatch = false;
      for (const e of schema.enum) {
        if (equals(val, e, node.type) || this.isAutoCompleteEqualMaybe(callFromAutoComplete, node, val, e)) {
          enumValueMatch = true;
          break;
        }
      }
      validationResult.enumValues = schema.enum;
      validationResult.enumValueMatch = enumValueMatch;
      if (!enumValueMatch) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          code: ErrorCode.EnumValueMismatch,
          message:
            schema.errorMessage ||
            l10n.t(
              'enumWarning',
              schema.enum
                .map((v) => {
                  return JSON.stringify(v);
                })
                .join(', ')
            ),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
          data: { values: schema.enum },
        });
      }
    }

    if (isDefined(schema.const)) {
      const val = getNodeValue(node);
      if (
        !equals(val, schema.const, node.type) &&
        !this.isAutoCompleteEqualMaybe(callFromAutoComplete, node, val, schema.const)
      ) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          code: ErrorCode.EnumValueMismatch,
          problemType: ProblemType.constWarning,
          message: schema.errorMessage || getWarningMessage(ProblemType.constWarning, [JSON.stringify(schema.const)]),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
          problemArgs: [JSON.stringify(schema.const)],
          data: { values: [schema.const] },
        });
        validationResult.enumValueMatch = false;
      } else {
        validationResult.enumValueMatch = true;
      }
      validationResult.enumValues = [schema.const];
    }

    if (schema.deprecationMessage && node.parent) {
      validationResult.problems.push({
        location: { offset: node.parent.offset, length: node.parent.length },
        severity: DiagnosticSeverity.Warning,
        message: schema.deprecationMessage,
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
    }
  }

  /**
   * Helper methods
   */
  protected getSchemaSource(schema: JSONSchema): string | undefined {
    if (schema) {
      let label: string;
      if (schema.title) {
        label = schema.title;
      } else if (schema.closestTitle) {
        label = schema.closestTitle;
      } else if (this.originalSchema.closestTitle) {
        label = this.originalSchema.closestTitle;
      } else {
        const uriString = schema.url ?? this.originalSchema.url;
        if (uriString) {
          const url = URI.parse(uriString);
          if (url.scheme === 'file') {
            label = url.fsPath;
          }
          label = url.toString();
        }
      }
      if (label) {
        return `${YAML_SCHEMA_PREFIX}${label}`;
      }
    }

    return YAML_SOURCE;
  }

  protected getSchemaUri(schema: JSONSchema): string[] {
    const uriString = schema.url ?? this.originalSchema.url;
    return uriString ? [uriString] : [];
  }

  protected isAutoCompleteEqualMaybe(
    callFromAutoComplete: boolean,
    node: ASTNode,
    nodeValue: unknown,
    schemaValue: unknown
  ): boolean {
    if (!callFromAutoComplete) {
      return false;
    }

    // if autocompletion property doesn't have value, then it could be a match
    const isWithoutValue = nodeValue === null && node.length === 0; // allows `prop: ` but ignore `prop: null`
    if (isWithoutValue) {
      return true;
    }

    return isString(nodeValue) && isString(schemaValue) && schemaValue.startsWith(nodeValue);
  }

  protected alternativeComparison(
    subValidationResult: ValidationResult,
    bestMatch: { schema: JSONSchema; validationResult: ValidationResult; matchingSchemas: ISchemaCollector },
    subSchema: JSONSchema,
    subMatchingSchemas: ISchemaCollector
  ): { schema: JSONSchema; validationResult: ValidationResult; matchingSchemas: ISchemaCollector } {
    const compareResult = subValidationResult.compareKubernetes(bestMatch.validationResult);
    if (compareResult > 0) {
      // our node is the best matching so far
      bestMatch = {
        schema: subSchema,
        validationResult: subValidationResult,
        matchingSchemas: subMatchingSchemas,
      };
    } else if (compareResult === 0) {
      // there's already a best matching but we are as good
      bestMatch.matchingSchemas.merge(subMatchingSchemas);
      bestMatch.validationResult.mergeEnumValues(subValidationResult);
      bestMatch.validationResult.mergeWarningGeneric(subValidationResult, [
        ProblemType.missingRequiredPropWarning,
        ProblemType.typeMismatchWarning,
        ProblemType.constWarning,
      ]);
    }
    return bestMatch;
  }

  protected genericComparison(
    node: ASTNode,
    maxOneMatch: boolean,
    subValidationResult: ValidationResult,
    bestMatch: { schema: JSONSchema; validationResult: ValidationResult; matchingSchemas: ISchemaCollector },
    subSchema: JSONSchema,
    subMatchingSchemas: ISchemaCollector
  ): { schema: JSONSchema; validationResult: ValidationResult; matchingSchemas: ISchemaCollector } {
    if (!maxOneMatch && !subValidationResult.hasProblems() && !bestMatch.validationResult.hasProblems()) {
      // no errors, both are equally good matches
      bestMatch.matchingSchemas.merge(subMatchingSchemas);
      bestMatch.validationResult.propertiesMatches += subValidationResult.propertiesMatches;
      bestMatch.validationResult.propertiesValueMatches += subValidationResult.propertiesValueMatches;
    } else {
      const compareResult = subValidationResult.compareGeneric(bestMatch.validationResult);
      if (
        compareResult > 0 ||
        (compareResult === 0 &&
          maxOneMatch &&
          bestMatch.schema.type === 'object' &&
          node.type !== 'null' &&
          node.type !== bestMatch.schema.type)
      ) {
        // our node is the best matching so far
        bestMatch = {
          schema: subSchema,
          validationResult: subValidationResult,
          matchingSchemas: subMatchingSchemas,
        };
      } else if (
        compareResult === 0 ||
        ((node.value === null || node.type === 'null') && node.length === 0) // node with no value can match any schema potentially
      ) {
        // there's already a best matching but we are as good
        bestMatch.matchingSchemas.merge(subMatchingSchemas);
        bestMatch.validationResult.mergeEnumValues(subValidationResult);
        bestMatch.validationResult.mergeWarningGeneric(subValidationResult, [
          ProblemType.missingRequiredPropWarning,
          ProblemType.typeMismatchWarning,
          ProblemType.constWarning,
        ]);
      }
    }
    return bestMatch;
  }

  /**
   * Common array constraint validation (minItems, maxItems, uniqueItems, contains)
   */
  protected validateArrayConstraints(node: ArrayASTNode, schema: JSONSchema, validationResult: ValidationResult): void {
    const { isKubernetes } = this.options;
    const containsSchema = asSchema(schema.contains);
    if (containsSchema) {
      const doesContain = node.items.some((item) => {
        const itemValidationResult = new ValidationResult(isKubernetes);
        this.validate(item, containsSchema, schema, itemValidationResult, NoOpSchemaCollector.instance, this.options);
        return !itemValidationResult.hasProblems();
      });

      if (!doesContain) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: schema.errorMessage || l10n.t('requiredItemMissingWarning'),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        });
      }
    }

    if (isNumber(schema.minItems) && node.items.length < schema.minItems) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: l10n.t('minItemsWarning', schema.minItems),
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
    }

    if (isNumber(schema.maxItems) && node.items.length > schema.maxItems) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Warning,
        message: l10n.t('maxItemsWarning', schema.maxItems),
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
    }

    if (schema.uniqueItems === true) {
      const values = getNodeValue(node);
      const duplicates = values.some((value, index) => {
        return index !== values.lastIndexOf(value);
      });
      if (duplicates) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: l10n.t('uniqueItemsWarning'),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        });
      }
    }
  }

  /**
   * Common object validation logic shared between validators
   */
  protected validateObjectNodeCommon(
    node: ObjectASTNode,
    schema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector,
    useUnevaluatedProperties: boolean
  ): void {
    const { isKubernetes } = this.options;
    const seenKeys: { [key: string]: ASTNode } = Object.create(null);
    const unprocessedProperties: string[] = [];
    const unprocessedNodes: PropertyASTNode[] = [...node.properties];

    while (unprocessedNodes.length > 0) {
      const propertyNode = unprocessedNodes.pop();
      const key = propertyNode.keyNode.value;

      //Replace the merge key with the actual values of what the node value points to in seen keys
      if (key === '<<' && propertyNode.valueNode) {
        switch (propertyNode.valueNode.type) {
          case 'object': {
            unprocessedNodes.push(...propertyNode.valueNode['properties']);
            break;
          }
          case 'array': {
            propertyNode.valueNode['items'].forEach((sequenceNode) => {
              if (sequenceNode && isIterable(sequenceNode['properties'])) {
                unprocessedNodes.push(...sequenceNode['properties']);
              }
            });
            break;
          }
          default: {
            break;
          }
        }
      } else {
        seenKeys[key] = propertyNode.valueNode;
        unprocessedProperties.push(key);
      }
    }

    if (Array.isArray(schema.required)) {
      for (const propertyName of schema.required) {
        if (seenKeys[propertyName] === undefined) {
          const keyNode = node.parent && node.parent.type === 'property' && node.parent.keyNode;
          const location = keyNode ? { offset: keyNode.offset, length: keyNode.length } : { offset: node.offset, length: 1 };
          validationResult.problems.push({
            location: location,
            severity: DiagnosticSeverity.Warning,
            message: schema.errorMessage || getWarningMessage(ProblemType.missingRequiredPropWarning, [propertyName]),
            source: this.getSchemaSource(schema),
            schemaUri: this.getSchemaUri(schema),
            problemArgs: [propertyName],
            problemType: ProblemType.missingRequiredPropWarning,
          });
        }
      }
    }

    const propertyProcessed = (prop: string): void => {
      let index = unprocessedProperties.indexOf(prop);
      while (index >= 0) {
        unprocessedProperties.splice(index, 1);
        index = unprocessedProperties.indexOf(prop);
      }
    };

    if (schema.properties) {
      for (const propertyName of Object.keys(schema.properties)) {
        propertyProcessed(propertyName);
        const propertySchema = schema.properties[propertyName];
        const child = seenKeys[propertyName];
        if (child) {
          if (isBoolean(propertySchema)) {
            if (!propertySchema) {
              const propertyNode = <PropertyASTNode>child.parent;
              validationResult.problems.push({
                location: {
                  offset: propertyNode.keyNode.offset,
                  length: propertyNode.keyNode.length,
                },
                severity: DiagnosticSeverity.Warning,
                message: schema.errorMessage || l10n.t('DisallowedExtraPropWarning', propertyName),
                source: this.getSchemaSource(schema),
                schemaUri: this.getSchemaUri(schema),
              });
            } else {
              validationResult.propertiesMatches++;
              validationResult.propertiesValueMatches++;
            }
          } else {
            propertySchema.url = schema.url ?? this.originalSchema.url;
            const propertyValidationResult = new ValidationResult(isKubernetes);
            this.validate(child, propertySchema, schema, propertyValidationResult, matchingSchemas, this.options);
            validationResult.mergePropertyMatch(propertyValidationResult);
            validationResult.mergeEnumValues(propertyValidationResult);
          }
        }
      }
    }

    if (schema.patternProperties) {
      for (const propertyPattern of Object.keys(schema.patternProperties)) {
        const regex = safeCreateUnicodeRegExp(propertyPattern);
        for (const propertyName of unprocessedProperties.slice(0)) {
          if (regex.test(propertyName)) {
            propertyProcessed(propertyName);
            const child = seenKeys[propertyName];
            if (child) {
              const propertySchema = schema.patternProperties[propertyPattern];
              if (isBoolean(propertySchema)) {
                if (!propertySchema) {
                  const propertyNode = <PropertyASTNode>child.parent;
                  validationResult.problems.push({
                    location: {
                      offset: propertyNode.keyNode.offset,
                      length: propertyNode.keyNode.length,
                    },
                    severity: DiagnosticSeverity.Warning,
                    message: schema.errorMessage || l10n.t('DisallowedExtraPropWarning', propertyName),
                    source: this.getSchemaSource(schema),
                    schemaUri: this.getSchemaUri(schema),
                  });
                } else {
                  validationResult.propertiesMatches++;
                  validationResult.propertiesValueMatches++;
                }
              } else {
                const propertyValidationResult = new ValidationResult(isKubernetes);
                this.validate(child, propertySchema, schema, propertyValidationResult, matchingSchemas, this.options);
                validationResult.mergePropertyMatch(propertyValidationResult);
                validationResult.mergeEnumValues(propertyValidationResult);
              }
            }
          }
        }
      }
    }

    // Handle additionalProperties (draft-07) or unevaluatedProperties (2019-09/2020-12)
    if (useUnevaluatedProperties && schema.unevaluatedProperties !== undefined) {
      if (typeof schema.unevaluatedProperties === 'object') {
        for (const propertyName of unprocessedProperties) {
          const child = seenKeys[propertyName];
          if (child) {
            const propertyValidationResult = new ValidationResult(isKubernetes);
            this.validate(
              child,
              <JSONSchema>schema.unevaluatedProperties,
              schema,
              propertyValidationResult,
              matchingSchemas,
              this.options
            );
            validationResult.mergePropertyMatch(propertyValidationResult);
            validationResult.mergeEnumValues(propertyValidationResult);
          }
        }
      } else if (schema.unevaluatedProperties === false) {
        if (unprocessedProperties.length > 0) {
          this.addUnprocessedPropertiesErrors(node, schema, validationResult, seenKeys, unprocessedProperties);
        }
      }
    } else if (typeof schema.additionalProperties === 'object') {
      for (const propertyName of unprocessedProperties) {
        const child = seenKeys[propertyName];
        if (child) {
          const propertyValidationResult = new ValidationResult(isKubernetes);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.validate(child, <any>schema.additionalProperties, schema, propertyValidationResult, matchingSchemas, this.options);
          validationResult.mergePropertyMatch(propertyValidationResult);
          validationResult.mergeEnumValues(propertyValidationResult);
        }
      }
    } else if (
      schema.additionalProperties === false ||
      (schema.type === 'object' && schema.additionalProperties === undefined && this.options.disableAdditionalProperties === true)
    ) {
      if (unprocessedProperties.length > 0) {
        this.addUnprocessedPropertiesErrors(node, schema, validationResult, seenKeys, unprocessedProperties);
      }
    }

    if (isNumber(schema.maxProperties)) {
      if (node.properties.length > schema.maxProperties) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: l10n.t('MaxPropWarning', schema.maxProperties),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        });
      }
    }

    if (isNumber(schema.minProperties)) {
      if (node.properties.length < schema.minProperties) {
        validationResult.problems.push({
          location: { offset: node.offset, length: node.length },
          severity: DiagnosticSeverity.Warning,
          message: l10n.t('MinPropWarning', schema.minProperties),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        });
      }
    }

    if (schema.dependencies) {
      for (const key of Object.keys(schema.dependencies)) {
        const prop = seenKeys[key];
        if (prop) {
          const propertyDep = schema.dependencies[key];
          if (Array.isArray(propertyDep)) {
            for (const requiredProp of propertyDep) {
              if (!seenKeys[requiredProp]) {
                validationResult.problems.push({
                  location: { offset: node.offset, length: node.length },
                  severity: DiagnosticSeverity.Warning,
                  message: l10n.t('RequiredDependentPropWarning', requiredProp, key),
                  source: this.getSchemaSource(schema),
                  schemaUri: this.getSchemaUri(schema),
                });
              } else {
                validationResult.propertiesValueMatches++;
              }
            }
          } else {
            const propertySchema = asSchema(propertyDep);
            if (propertySchema) {
              const propertyValidationResult = new ValidationResult(isKubernetes);
              this.validate(node, propertySchema, schema, propertyValidationResult, matchingSchemas, this.options);
              validationResult.mergePropertyMatch(propertyValidationResult);
              validationResult.mergeEnumValues(propertyValidationResult);
            }
          }
        }
      }
    }

    const propertyNames = asSchema(schema.propertyNames);
    if (propertyNames) {
      for (const f of node.properties) {
        const key = f.keyNode;
        if (key) {
          this.validate(key, propertyNames, schema, validationResult, NoOpSchemaCollector.instance, this.options);
        }
      }
    }
  }

  protected addUnprocessedPropertiesErrors(
    node: ObjectASTNode,
    schema: JSONSchema,
    validationResult: ValidationResult,
    seenKeys: { [key: string]: ASTNode },
    unprocessedProperties: string[]
  ): void {
    const possibleProperties =
      schema.properties &&
      Object.entries(schema.properties)
        .filter(([key, property]) => {
          // don't include existing properties
          if (seenKeys[key]) {
            return false;
          }
          // don't include properties that are not suggested in completion
          if (property && typeof property === 'object' && (property.doNotSuggest || property.deprecationMessage)) {
            return false;
          }
          return true;
        })
        .map(([key]) => key);

    for (const propertyName of unprocessedProperties) {
      const child = seenKeys[propertyName];
      if (child) {
        let propertyNode = null;
        if (child.type !== 'property') {
          propertyNode = <PropertyASTNode>child.parent;
          if (propertyNode.type === 'object') {
            propertyNode = propertyNode.properties[0];
          }
        } else {
          propertyNode = child;
        }
        const problem: IProblem = {
          location: {
            offset: propertyNode.keyNode.offset,
            length: propertyNode.keyNode.length,
          },
          severity: DiagnosticSeverity.Warning,
          code: ErrorCode.PropertyExpected,
          message: schema.errorMessage || l10n.t('DisallowedExtraPropWarning', propertyName),
          source: this.getSchemaSource(schema),
          schemaUri: this.getSchemaUri(schema),
        };
        if (possibleProperties?.length) {
          problem.data = { properties: possibleProperties };
        }
        validationResult.problems.push(problem);
      }
    }
  }
}
