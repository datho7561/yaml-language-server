/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JSONSchema } from '../jsonSchema';
import { ArrayASTNode } from '../jsonASTTypes';
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { ValidationResult, asSchema, ISchemaCollector } from './jsonParser07';
import { Draft2019Validator } from './draft2019Validator';

/**
 * Validator for JSON Schema Draft 2020-12
 * Same as 2019-09 but items can only be a schema (not an array)
 */
export class Draft2020Validator extends Draft2019Validator {
  protected validateArrayNode(
    node: ArrayASTNode,
    schema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector
  ): void {
    const { isKubernetes } = this.options;

    // In 2020-12, items cannot be an array - it must use prefixItems instead
    if (Array.isArray(schema.items)) {
      validationResult.problems.push({
        location: { offset: node.offset, length: node.length },
        severity: DiagnosticSeverity.Error,
        message: 'In JSON Schema 2020-12, items cannot be an array. Use prefixItems instead.',
        source: this.getSchemaSource(schema),
        schemaUri: this.getSchemaUri(schema),
      });
      return;
    }

    // Use prefixItems for array form
    if (schema.prefixItems && Array.isArray(schema.prefixItems)) {
      for (let index = 0; index < schema.prefixItems.length; index++) {
        const subSchemaRef = schema.prefixItems[index];
        const subSchema = asSchema(subSchemaRef);
        const itemValidationResult = new ValidationResult(isKubernetes);
        const item = node.items[index];
        if (item) {
          this.validate(item, subSchema, schema, itemValidationResult, matchingSchemas, this.options);
          validationResult.mergePropertyMatch(itemValidationResult);
          validationResult.mergeEnumValues(itemValidationResult);
        } else if (node.items.length >= schema.prefixItems.length) {
          validationResult.propertiesValueMatches++;
        }
      }

      // Handle unevaluatedItems for items beyond prefixItems
      if (node.items.length > schema.prefixItems.length) {
        if (schema.unevaluatedItems !== undefined) {
          if (typeof schema.unevaluatedItems === 'object') {
            for (let i = schema.prefixItems.length; i < node.items.length; i++) {
              const itemValidationResult = new ValidationResult(isKubernetes);
              this.validate(
                node.items[i],
                <JSONSchema>schema.unevaluatedItems,
                schema,
                itemValidationResult,
                matchingSchemas,
                this.options
              );
              validationResult.mergePropertyMatch(itemValidationResult);
              validationResult.mergeEnumValues(itemValidationResult);
            }
          } else if (schema.unevaluatedItems === false) {
            validationResult.problems.push({
              location: { offset: node.offset, length: node.length },
              severity: DiagnosticSeverity.Error,
              message: l10n.t('additionalItemsWarning', schema.prefixItems.length),
              source: this.getSchemaSource(schema),
              schemaUri: this.getSchemaUri(schema),
            });
          }
        }
      }
    } else {
      // Handle items as single schema (only form allowed in 2020-12)
      const itemSchema = asSchema(schema.items);
      if (itemSchema) {
        const itemValidationResult = new ValidationResult(isKubernetes);
        node.items.forEach((item) => {
          if (itemSchema.oneOf && itemSchema.oneOf.length === 1) {
            const subSchemaRef = itemSchema.oneOf[0];
            const subSchema = { ...asSchema(subSchemaRef) };
            subSchema.title = schema.title;
            subSchema.closestTitle = schema.closestTitle;
            this.validate(item, subSchema, schema, itemValidationResult, matchingSchemas, this.options);
            validationResult.mergePropertyMatch(itemValidationResult);
            validationResult.mergeEnumValues(itemValidationResult);
          } else {
            this.validate(item, itemSchema, schema, itemValidationResult, matchingSchemas, this.options);
            validationResult.mergePropertyMatch(itemValidationResult);
            validationResult.mergeEnumValues(itemValidationResult);
          }
        });
      }
    }

    this.validateArrayConstraints(node, schema, validationResult);
  }
}
