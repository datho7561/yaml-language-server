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
import { SchemaValidator } from './schemaValidator';

/**
 * Validator for JSON Schema Draft-07
 * Supports items as array or schema, additionalItems, definitions, additionalProperties
 */
export class Draft07Validator extends SchemaValidator {
  protected validateArrayNode(
    node: ArrayASTNode,
    schema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector
  ): void {
    const { isKubernetes } = this.options;
    if (Array.isArray(schema.items)) {
      const subSchemas = schema.items;
      for (let index = 0; index < subSchemas.length; index++) {
        const subSchemaRef = subSchemas[index];
        const subSchema = asSchema(subSchemaRef);
        const itemValidationResult = new ValidationResult(isKubernetes);
        const item = node.items[index];
        if (item) {
          this.validate(item, subSchema, schema, itemValidationResult, matchingSchemas, this.options);
          validationResult.mergePropertyMatch(itemValidationResult);
          validationResult.mergeEnumValues(itemValidationResult);
        } else if (node.items.length >= subSchemas.length) {
          validationResult.propertiesValueMatches++;
        }
      }
      if (node.items.length > subSchemas.length) {
        if (typeof schema.additionalItems === 'object') {
          for (let i = subSchemas.length; i < node.items.length; i++) {
            const itemValidationResult = new ValidationResult(isKubernetes);
            this.validate(
              node.items[i],
              <JSONSchema>schema.additionalItems,
              schema,
              itemValidationResult,
              matchingSchemas,
              this.options
            );
            validationResult.mergePropertyMatch(itemValidationResult);
            validationResult.mergeEnumValues(itemValidationResult);
          }
        } else if (schema.additionalItems === false) {
          validationResult.problems.push({
            location: { offset: node.offset, length: node.length },
            severity: DiagnosticSeverity.Warning,
            message: l10n.t('additionalItemsWarning', subSchemas.length),
            source: this.getSchemaSource(schema),
            schemaUri: this.getSchemaUri(schema),
          });
        }
      }
    } else {
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

  protected validateObjectNode(
    node: ObjectASTNode,
    schema: JSONSchema,
    validationResult: ValidationResult,
    matchingSchemas: ISchemaCollector
  ): void {
    this.validateObjectNodeCommon(node, schema, validationResult, matchingSchemas, false);
  }
}
