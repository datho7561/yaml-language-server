/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JSONSchema } from '../jsonSchema';
import { ObjectASTNode, ArrayASTNode } from '../jsonASTTypes';
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity } from 'vscode-languageserver-types';
import { ValidationResult, asSchema, ISchemaCollector } from './jsonParser07';
import { Draft07Validator } from './draft07Validator';

/**
 * Validator for JSON Schema Draft 2019-09
 * Supports prefixItems, unevaluatedItems, unevaluatedProperties, $defs
 */
export class Draft2019Validator extends Draft07Validator {
  protected validateArrayNode(
    node: ArrayASTNode,
    schema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector
  ): void {
    const { isKubernetes } = this.options;
    const prefixItems = schema.prefixItems || (Array.isArray(schema.items) ? schema.items : undefined);

    if (prefixItems && Array.isArray(prefixItems)) {
      // Handle prefixItems (array form)
      for (let index = 0; index < prefixItems.length; index++) {
        const subSchemaRef = prefixItems[index];
        const subSchema = asSchema(subSchemaRef);
        const itemValidationResult = new ValidationResult(isKubernetes);
        const item = node.items[index];
        if (item) {
          this.validate(item, subSchema, schema, itemValidationResult, matchingSchemas, this.options);
          validationResult.mergePropertyMatch(itemValidationResult);
          validationResult.mergeEnumValues(itemValidationResult);
        } else if (node.items.length >= prefixItems.length) {
          validationResult.propertiesValueMatches++;
        }
      }

      // Handle unevaluatedItems for items beyond prefixItems
      if (node.items.length > prefixItems.length) {
        if (schema.unevaluatedItems !== undefined) {
          if (typeof schema.unevaluatedItems === 'object') {
            for (let i = prefixItems.length; i < node.items.length; i++) {
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
              message: l10n.t('additionalItemsWarning', prefixItems.length),
              source: this.getSchemaSource(schema),
              schemaUri: this.getSchemaUri(schema),
            });
          }
        }
      }
    } else {
      // Handle items as single schema (not array)
      const itemSchema = Array.isArray(schema.items) ? undefined : asSchema(schema.items);
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

  protected validateObjectNode(
    node: ObjectASTNode,
    schema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector
  ): void {
    // $defs is handled during reference resolution in yamlSchemaService, not here
    this.validateObjectNodeCommon(node, schema, validationResult, matchingSchemas, true);
  }
}
