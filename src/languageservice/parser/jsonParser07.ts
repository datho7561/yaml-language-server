/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JSONSchema, JSONSchemaRef } from '../jsonSchema';
import { isBoolean } from '../utils/objects';
import {
  ASTNode,
  ObjectASTNode,
  ArrayASTNode,
  BooleanASTNode,
  NumberASTNode,
  StringASTNode,
  NullASTNode,
  PropertyASTNode,
  YamlNode,
} from '../jsonASTTypes';
import { ErrorCode } from 'vscode-json-languageservice';
import * as l10n from '@vscode/l10n';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { isArrayEqual } from '../utils/arrUtils';
import { Node, Pair } from 'yaml';
import { SchemaValidator } from './schemaValidator';
import { Draft07Validator } from './draft07Validator';
import { Draft2019Validator } from './draft2019Validator';
import { Draft2020Validator } from './draft2020Validator';

export interface IRange {
  offset: number;
  length: number;
}

export const formats = {
  'color-hex': {
    errorMessage: l10n.t('colorHexFormatWarning'),
    pattern: /^#([0-9A-Fa-f]{3,4}|([0-9A-Fa-f]{2}){3,4})$/,
  },
  'date-time': {
    errorMessage: l10n.t('dateTimeFormatWarning'),
    pattern:
      /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)([01][0-9]|2[0-3]):([0-5][0-9]))$/i,
  },
  date: {
    errorMessage: l10n.t('dateFormatWarning'),
    pattern: /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/i,
  },
  time: {
    errorMessage: l10n.t('timeFormatWarning'),
    pattern: /^([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9]|60)(\.[0-9]+)?(Z|(\+|-)([01][0-9]|2[0-3]):([0-5][0-9]))$/i,
  },
  email: {
    errorMessage: l10n.t('emailFormatWarning'),
    pattern:
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
  },
  ipv4: {
    errorMessage: l10n.t('ipv4FormatWarning'),
    pattern: /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/,
  },
  ipv6: {
    errorMessage: l10n.t('ipv6FormatWarning'),
    pattern: /^([0-9a-f]|:){1,4}(:([0-9a-f]{0,4})*){1,7}$/i,
  },
};

export const YAML_SOURCE = 'YAML';
export const YAML_SCHEMA_PREFIX = 'yaml-schema: ';

export enum ProblemType {
  missingRequiredPropWarning = 'missingRequiredPropWarning',
  typeMismatchWarning = 'typeMismatchWarning',
  constWarning = 'constWarning',
}

export const ProblemTypeMessages: Record<ProblemType, string> = {
  [ProblemType.missingRequiredPropWarning]: 'Missing property "{0}".',
  [ProblemType.typeMismatchWarning]: 'Incorrect type. Expected "{0}".',
  [ProblemType.constWarning]: 'Value must be {0}.',
};
export interface IProblem {
  location: IRange;
  severity: DiagnosticSeverity;
  code?: ErrorCode;
  message: string;
  source?: string;
  problemType?: ProblemType;
  problemArgs?: string[];
  schemaUri?: string[];
  data?: Record<string, unknown>;
}

export abstract class ASTNodeImpl {
  public abstract readonly type: 'object' | 'property' | 'array' | 'number' | 'boolean' | 'null' | 'string';

  public offset: number;
  public length: number;
  public readonly parent: ASTNode;
  public location: string;
  readonly internalNode: YamlNode;

  constructor(parent: ASTNode, internalNode: YamlNode, offset: number, length?: number) {
    this.offset = offset;
    this.length = length;
    this.parent = parent;
    this.internalNode = internalNode;
  }

  public getNodeFromOffsetEndInclusive(offset: number): ASTNode {
    const collector = [];
    const findNode = (node: ASTNode | ASTNodeImpl): ASTNode | ASTNodeImpl => {
      if (offset >= node.offset && offset <= node.offset + node.length) {
        const children = node.children;
        for (let i = 0; i < children.length && children[i].offset <= offset; i++) {
          const item = findNode(children[i]);
          if (item) {
            collector.push(item);
          }
        }
        return node;
      }
      return null;
    };
    const foundNode = findNode(this);
    let currMinDist = Number.MAX_VALUE;
    let currMinNode = null;
    for (const currNode of collector) {
      const minDist = currNode.length + currNode.offset - offset + (offset - currNode.offset);
      if (minDist < currMinDist) {
        currMinNode = currNode;
        currMinDist = minDist;
      }
    }
    return currMinNode || foundNode;
  }

  public get children(): ASTNode[] {
    return [];
  }

  public toString(): string {
    return (
      'type: ' +
      this.type +
      ' (' +
      this.offset +
      '/' +
      this.length +
      ')' +
      (this.parent ? ' parent: {' + this.parent.toString() + '}' : '')
    );
  }
}

export class NullASTNodeImpl extends ASTNodeImpl implements NullASTNode {
  public type: 'null' = 'null' as const;
  public value = null;
  constructor(parent: ASTNode, internalNode: Node, offset: number, length?: number) {
    super(parent, internalNode, offset, length);
  }
}

export class BooleanASTNodeImpl extends ASTNodeImpl implements BooleanASTNode {
  public type: 'boolean' = 'boolean' as const;
  public value: boolean;
  public source: string;

  constructor(parent: ASTNode, internalNode: Node, boolValue: boolean, boolSource: string, offset: number, length?: number) {
    super(parent, internalNode, offset, length);
    this.value = boolValue;
    this.source = boolSource;
  }
}

export class ArrayASTNodeImpl extends ASTNodeImpl implements ArrayASTNode {
  public type: 'array' = 'array' as const;
  public items: ASTNode[];

  constructor(parent: ASTNode, internalNode: Node, offset: number, length?: number) {
    super(parent, internalNode, offset, length);
    this.items = [];
  }

  public get children(): ASTNode[] {
    return this.items;
  }
}

export class NumberASTNodeImpl extends ASTNodeImpl implements NumberASTNode {
  public type: 'number' = 'number' as const;
  public isInteger: boolean;
  public value: number;

  constructor(parent: ASTNode, internalNode: Node, offset: number, length?: number) {
    super(parent, internalNode, offset, length);
    this.isInteger = true;
    this.value = Number.NaN;
  }
}

export class StringASTNodeImpl extends ASTNodeImpl implements StringASTNode {
  public type: 'string' = 'string' as const;
  public value: string;

  constructor(parent: ASTNode, internalNode: Node, offset: number, length?: number) {
    super(parent, internalNode, offset, length);
    this.value = '';
  }
}

export class PropertyASTNodeImpl extends ASTNodeImpl implements PropertyASTNode {
  public type: 'property' = 'property' as const;
  public keyNode: StringASTNode;
  public valueNode: ASTNode;
  public colonOffset: number;

  constructor(parent: ObjectASTNode, internalNode: Pair, offset: number, length?: number) {
    super(parent, internalNode, offset, length);
    this.colonOffset = -1;
  }

  public get children(): ASTNode[] {
    return this.valueNode ? [this.keyNode, this.valueNode] : [this.keyNode];
  }
}

export class ObjectASTNodeImpl extends ASTNodeImpl implements ObjectASTNode {
  public type: 'object' = 'object' as const;
  public properties: PropertyASTNode[];

  constructor(parent: ASTNode, internalNode: Node, offset: number, length?: number) {
    super(parent, internalNode, offset, length);

    this.properties = [];
  }

  public get children(): ASTNode[] {
    return this.properties;
  }
}

export function asSchema(schema: JSONSchemaRef): JSONSchema | undefined {
  if (schema === undefined) {
    return undefined;
  }

  if (isBoolean(schema)) {
    return schema ? {} : { not: {} };
  }

  if (typeof schema !== 'object') {
    // we need to report this case as JSONSchemaRef MUST be an Object or Boolean
    console.warn(`Wrong schema: ${JSON.stringify(schema)}, it MUST be an Object or Boolean`);
    schema = {
      type: schema,
    };
  }
  return schema;
}

export interface JSONDocumentConfig {
  collectComments?: boolean;
}

export interface IApplicableSchema {
  node: ASTNode;
  inverted?: boolean;
  schema: JSONSchema;
}

export enum EnumMatch {
  Key,
  Enum,
}

export interface ISchemaCollector {
  schemas: IApplicableSchema[];
  add(schema: IApplicableSchema): void;
  merge(other: ISchemaCollector): void;
  include(node: ASTNode): boolean;
  newSub(): ISchemaCollector;
}

class SchemaCollector implements ISchemaCollector {
  schemas: IApplicableSchema[] = [];
  constructor(
    private focusOffset = -1,
    private exclude: ASTNode = null
  ) {}
  add(schema: IApplicableSchema): void {
    this.schemas.push(schema);
  }
  merge(other: ISchemaCollector): void {
    this.schemas.push(...other.schemas);
  }
  include(node: ASTNode): boolean {
    return (this.focusOffset === -1 || contains(node, this.focusOffset)) && node !== this.exclude;
  }
  newSub(): ISchemaCollector {
    return new SchemaCollector(-1, this.exclude);
  }
}

export class NoOpSchemaCollector implements ISchemaCollector {
  private constructor() {
    // ignore
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get schemas(): any[] {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  add(schema: IApplicableSchema): void {
    // ignore
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  merge(other: ISchemaCollector): void {
    // ignore
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  include(node: ASTNode): boolean {
    return true;
  }
  newSub(): ISchemaCollector {
    return this;
  }

  static instance = new NoOpSchemaCollector();
}

export class ValidationResult {
  public problems: IProblem[];

  public propertiesMatches: number;
  public propertiesValueMatches: number;
  public primaryValueMatches: number;
  public enumValueMatch: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public enumValues: any[];

  constructor(isKubernetes: boolean) {
    this.problems = [];
    this.propertiesMatches = 0;
    this.propertiesValueMatches = 0;
    this.primaryValueMatches = 0;
    this.enumValueMatch = false;
    if (isKubernetes) {
      this.enumValues = [];
    } else {
      this.enumValues = null;
    }
  }

  public hasProblems(): boolean {
    return !!this.problems.length;
  }

  public mergeAll(validationResults: ValidationResult[]): void {
    for (const validationResult of validationResults) {
      this.merge(validationResult);
    }
  }

  public merge(validationResult: ValidationResult): void {
    this.problems = this.problems.concat(validationResult.problems);
  }

  public mergeEnumValues(validationResult: ValidationResult): void {
    if (!this.enumValueMatch && !validationResult.enumValueMatch && this.enumValues && validationResult.enumValues) {
      this.enumValues = this.enumValues.concat(validationResult.enumValues);
      for (const error of this.problems) {
        if (error.code === ErrorCode.EnumValueMismatch) {
          error.message = l10n.t(
            'enumWarning',
            [...new Set(this.enumValues)]
              .map((v) => {
                return JSON.stringify(v);
              })
              .join(', ')
          );
        }
      }
    }
  }

  /**
   * Merge multiple warnings with same problemType together
   * @param subValidationResult another possible result
   */
  public mergeWarningGeneric(subValidationResult: ValidationResult, problemTypesToMerge: ProblemType[]): void {
    if (this.problems?.length) {
      for (const problemType of problemTypesToMerge) {
        const bestResults = this.problems.filter((p) => p.problemType === problemType);
        for (const bestResult of bestResults) {
          const mergingResult = subValidationResult.problems?.find(
            (p) =>
              p.problemType === problemType &&
              bestResult.location.offset === p.location.offset &&
              (problemType !== ProblemType.missingRequiredPropWarning || isArrayEqual(p.problemArgs, bestResult.problemArgs)) // missingProp is merged only with same problemArg
          );
          if (mergingResult) {
            if (mergingResult.problemArgs?.length) {
              mergingResult.problemArgs
                .filter((p) => !bestResult.problemArgs.includes(p))
                .forEach((p) => bestResult.problemArgs.push(p));
              bestResult.message = getWarningMessage(bestResult.problemType, bestResult.problemArgs);
            }
            this.mergeSources(mergingResult, bestResult);
          }
        }
      }
    }
  }

  public mergePropertyMatch(propertyValidationResult: ValidationResult): void {
    this.merge(propertyValidationResult);
    this.propertiesMatches++;
    if (
      propertyValidationResult.enumValueMatch ||
      (!propertyValidationResult.hasProblems() && propertyValidationResult.propertiesMatches)
    ) {
      this.propertiesValueMatches++;
    }
    if (propertyValidationResult.enumValueMatch && propertyValidationResult.enumValues) {
      this.primaryValueMatches++;
    }
  }

  private mergeSources(mergingResult: IProblem, bestResult: IProblem): void {
    const mergingSource = mergingResult.source.replace(YAML_SCHEMA_PREFIX, '');
    if (!bestResult.source.includes(mergingSource)) {
      bestResult.source = bestResult.source + ' | ' + mergingSource;
    }
    if (!bestResult.schemaUri.includes(mergingResult.schemaUri[0])) {
      bestResult.schemaUri = bestResult.schemaUri.concat(mergingResult.schemaUri);
    }
  }

  public compareGeneric(other: ValidationResult): number {
    const hasProblems = this.hasProblems();
    if (hasProblems !== other.hasProblems()) {
      return hasProblems ? -1 : 1;
    }
    if (this.enumValueMatch !== other.enumValueMatch) {
      return other.enumValueMatch ? -1 : 1;
    }
    if (this.propertiesValueMatches !== other.propertiesValueMatches) {
      return this.propertiesValueMatches - other.propertiesValueMatches;
    }
    if (this.primaryValueMatches !== other.primaryValueMatches) {
      return this.primaryValueMatches - other.primaryValueMatches;
    }
    return this.propertiesMatches - other.propertiesMatches;
  }

  public compareKubernetes(other: ValidationResult): number {
    const hasProblems = this.hasProblems();
    if (this.propertiesMatches !== other.propertiesMatches) {
      return this.propertiesMatches - other.propertiesMatches;
    }
    if (this.enumValueMatch !== other.enumValueMatch) {
      return other.enumValueMatch ? -1 : 1;
    }
    if (this.primaryValueMatches !== other.primaryValueMatches) {
      return this.primaryValueMatches - other.primaryValueMatches;
    }
    if (this.propertiesValueMatches !== other.propertiesValueMatches) {
      return this.propertiesValueMatches - other.propertiesValueMatches;
    }
    if (hasProblems !== other.hasProblems()) {
      return hasProblems ? -1 : 1;
    }
    return this.propertiesMatches - other.propertiesMatches;
  }
}

export function newJSONDocument(root: ASTNode, diagnostics: Diagnostic[] = []): JSONDocument {
  return new JSONDocument(root, diagnostics, []);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getNodeValue(node: ASTNode): any {
  switch (node.type) {
    case 'array':
      return node.children.map(getNodeValue);
    case 'object': {
      const obj = Object.create(null);
      for (let _i = 0, _a = node.children; _i < _a.length; _i++) {
        const prop = _a[_i];
        const valueNode = prop.children[1];
        if (valueNode) {
          obj[prop.children[0].value as string] = getNodeValue(valueNode);
        }
      }
      return obj;
    }
    case 'null':
    case 'string':
    case 'number':
      return node.value;
    case 'boolean':
      return node.source;
    default:
      return undefined;
  }
}

export function contains(node: ASTNode, offset: number, includeRightBound = false): boolean {
  return (
    (offset >= node.offset && offset <= node.offset + node.length) || (includeRightBound && offset === node.offset + node.length)
  );
}

export function findNodeAtOffset(node: ASTNode, offset: number, includeRightBound: boolean): ASTNode {
  if (includeRightBound === void 0) {
    includeRightBound = false;
  }
  if (contains(node, offset, includeRightBound)) {
    const children = node.children;
    if (Array.isArray(children)) {
      for (let i = 0; i < children.length && children[i].offset <= offset; i++) {
        const item = findNodeAtOffset(children[i], offset, includeRightBound);
        if (item) {
          return item;
        }
      }
    }
    return node;
  }
  return undefined;
}

export class JSONDocument {
  public isKubernetes: boolean;
  public disableAdditionalProperties: boolean;
  public uri: string;

  constructor(
    public readonly root: ASTNode,
    public readonly syntaxErrors: Diagnostic[] = [],
    public readonly comments: Range[] = []
  ) {}

  public getNodeFromOffset(offset: number, includeRightBound = false): ASTNode | undefined {
    if (this.root) {
      return findNodeAtOffset(this.root, offset, includeRightBound);
    }
    return undefined;
  }

  public getNodeFromOffsetEndInclusive(offset: number): ASTNode {
    return this.root && this.root.getNodeFromOffsetEndInclusive(offset);
  }

  public visit(visitor: (node: ASTNode) => boolean): void {
    if (this.root) {
      const doVisit = (node: ASTNode): boolean => {
        let ctn = visitor(node);
        const children = node.children;
        if (Array.isArray(children)) {
          for (let i = 0; i < children.length && ctn; i++) {
            ctn = doVisit(children[i]);
          }
        }
        return ctn;
      };
      doVisit(this.root);
    }
  }

  public validate(textDocument: TextDocument, schema: JSONSchema): Diagnostic[] {
    if (this.root && schema) {
      const validationResult = new ValidationResult(this.isKubernetes);
      const validator = createValidatorForSchema(schema);
      validator.validate(this.root, schema, schema, validationResult, NoOpSchemaCollector.instance, {
        isKubernetes: this.isKubernetes,
        disableAdditionalProperties: this.disableAdditionalProperties,
        uri: this.uri,
      });
      return validationResult.problems.map((p) => {
        const range = Range.create(
          textDocument.positionAt(p.location.offset),
          textDocument.positionAt(p.location.offset + p.location.length)
        );
        const diagnostic: Diagnostic = Diagnostic.create(
          range,
          p.message,
          p.severity,
          p.code ? p.code : ErrorCode.Undefined,
          p.source
        );
        diagnostic.data = { schemaUri: p.schemaUri, ...p.data };
        return diagnostic;
      });
    }
    return null;
  }

  /**
   * This method returns the list of applicable schemas
   *
   * currently used @param didCallFromAutoComplete flag to differentiate the method call, when it is from auto complete
   * then user still types something and skip the validation for timebeing untill completed.
   * On https://github.com/redhat-developer/yaml-language-server/pull/719 the auto completes need to populate the list of enum string which matches to the enum
   * and on https://github.com/redhat-developer/vscode-yaml/issues/803 the validation should throw the error based on the enum string.
   *
   * @param schema schema
   * @param focusOffset  offsetValue
   * @param exclude excluded Node
   * @param didCallFromAutoComplete true if method called from AutoComplete
   * @returns array of applicable schemas
   */
  public getMatchingSchemas(
    schema: JSONSchema,
    focusOffset = -1,
    exclude: ASTNode = null,
    didCallFromAutoComplete?: boolean
  ): IApplicableSchema[] {
    const matchingSchemas = new SchemaCollector(focusOffset, exclude);
    if (this.root && schema) {
      const validator = createValidatorForSchema(schema);
      validator.validate(this.root, schema, schema, new ValidationResult(this.isKubernetes), matchingSchemas, {
        isKubernetes: this.isKubernetes,
        disableAdditionalProperties: this.disableAdditionalProperties,
        uri: this.uri,
        callFromAutoComplete: didCallFromAutoComplete,
      });
    }
    return matchingSchemas.schemas;
  }
}

export function getWarningMessage(problemType: ProblemType, args: string[]): string {
  return l10n.t(ProblemTypeMessages[problemType], args.join(' | '));
}

/**
 * Factory function to create the appropriate validator based on schema version
 */
function createValidatorForSchema(schema: JSONSchema): SchemaValidator {
  const schemaVersion = schema.$schema;

  if (schemaVersion) {
    if (schemaVersion.includes('2020-12') || schemaVersion.includes('draft/2020-12')) {
      return new Draft2020Validator();
    } else if (schemaVersion.includes('2019-09') || schemaVersion.includes('draft/2019-09')) {
      return new Draft2019Validator();
    }
  }

  // Default to draft-07 validator for backward compatibility
  return new Draft07Validator();
}
