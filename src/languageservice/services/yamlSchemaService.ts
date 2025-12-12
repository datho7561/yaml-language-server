/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JSONSchema, JSONSchemaMap, JSONSchemaRef } from '../jsonSchema';
import { SchemaPriority, SchemaRequestService, WorkspaceContextService } from '../yamlLanguageService';
import {
  UnresolvedSchema,
  ResolvedSchema,
  JSONSchemaService,
  SchemaDependencies,
  ISchemaContributions,
  SchemaHandle,
} from 'vscode-json-languageservice/lib/umd/services/jsonSchemaService';

import { URI } from 'vscode-uri';
import * as l10n from '@vscode/l10n';
import { convertSimple2RegExpPattern } from '../utils/strings';
import { SingleYAMLDocument } from '../parser/yamlParser07';
import { JSONDocument } from '../parser/jsonParser07';
import * as path from 'path';
import { getSchemaFromModeline } from './modelineUtil';
import { JSONSchemaDescriptionExt } from '../../requestTypes';
import { SchemaVersions } from '../yamlTypes';

import { parse } from 'yaml';
import * as Json from 'jsonc-parser';
import Ajv, { DefinedError } from 'ajv';
import Ajv4 from 'ajv-draft-04';
import { getSchemaTitle } from '../utils/schemaUtils';

const ajv = new Ajv({ strict: false, allowMatchingProperties: true });
const ajv4 = new Ajv4();

// load JSON Schema 07 def to validate loaded schemas
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsonSchema07 = require('ajv/dist/refs/json-schema-draft-07.json');
const schema07Validator = ajv.compile(jsonSchema07);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsonSchema04 = require('ajv-draft-04/dist/refs/json-schema-draft-04.json');
const schema04Validator = ajv4.compile(jsonSchema04);
const SCHEMA_04_URI_WITH_HTTPS = ajv4.defaultMeta().replace('http://', 'https://');

// load JSON Schema 2019-09 and 2020-12 metaschemas
// Use Ajv's helper functions to properly load all meta schemas
// eslint-disable-next-line @typescript-eslint/no-var-requires
const addMetaSchema2019 = require('ajv/dist/refs/json-schema-2019-09').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const addMetaSchema2020 = require('ajv/dist/refs/json-schema-2020-12').default;

addMetaSchema2019.call(ajv);
addMetaSchema2020.call(ajv);

// Load the actual schema JSON objects and compile them directly (safer than getSchema)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsonSchema2019 = require('ajv/dist/refs/json-schema-2019-09/schema.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsonSchema2020 = require('ajv/dist/refs/json-schema-2020-12/schema.json');

const schema2019Validator = ajv.compile(jsonSchema2019);
const SCHEMA_2019_URI = 'https://json-schema.org/draft/2019-09/schema';
const SCHEMA_2019_URI_HTTP = 'http://json-schema.org/draft/2019-09/schema';

const schema2020Validator = ajv.compile(jsonSchema2020);
const SCHEMA_2020_URI = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_2020_URI_HTTP = 'http://json-schema.org/draft/2020-12/schema';

export declare type CustomSchemaProvider = (uri: string) => Promise<string | string[]>;

export enum MODIFICATION_ACTIONS {
  'delete',
  'add',
  'deleteAll',
}

export interface SchemaAdditions {
  schema: string;
  action: MODIFICATION_ACTIONS.add;
  path: string;
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any;
}

export interface SchemaDeletions {
  schema: string;
  action: MODIFICATION_ACTIONS.delete;
  path: string;
  key: string;
}

export interface SchemaDeletionsAll {
  schemas: string[];
  action: MODIFICATION_ACTIONS.deleteAll;
}

export class FilePatternAssociation {
  private schemas: string[];
  private patternRegExp: RegExp;

  constructor(pattern: string) {
    try {
      this.patternRegExp = new RegExp(convertSimple2RegExpPattern(pattern) + '$');
    } catch (e) {
      // invalid pattern
      this.patternRegExp = null;
    }
    this.schemas = [];
  }

  public addSchema(id: string): void {
    this.schemas.push(id);
  }

  public matchesPattern(fileName: string): boolean {
    return this.patternRegExp && this.patternRegExp.test(fileName);
  }

  public getSchemas(): string[] {
    return this.schemas;
  }
}
interface SchemaStoreSchema {
  name: string;
  description: string;
  versions?: SchemaVersions;
}
export class YAMLSchemaService extends JSONSchemaService {
  // To allow to use schemasById from super.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [x: string]: any;

  private customSchemaProvider: CustomSchemaProvider | undefined;
  private filePatternAssociations: JSONSchemaService.FilePatternAssociation[];
  private contextService: WorkspaceContextService;
  private requestService: SchemaRequestService;
  public schemaPriorityMapping: Map<string, Set<SchemaPriority>>;

  private schemaUriToNameAndDescription = new Map<string, SchemaStoreSchema>();

  constructor(
    requestService: SchemaRequestService,
    contextService?: WorkspaceContextService,
    promiseConstructor?: PromiseConstructor
  ) {
    super(requestService, contextService, promiseConstructor);
    this.customSchemaProvider = undefined;
    this.requestService = requestService;
    this.schemaPriorityMapping = new Map();
  }

  registerCustomSchemaProvider(customSchemaProvider: CustomSchemaProvider): void {
    this.customSchemaProvider = customSchemaProvider;
  }

  getAllSchemas(): JSONSchemaDescriptionExt[] {
    const result: JSONSchemaDescriptionExt[] = [];
    const schemaUris = new Set<string>();
    for (const filePattern of this.filePatternAssociations) {
      const schemaUri = filePattern.uris[0];
      if (schemaUris.has(schemaUri)) {
        continue;
      }
      schemaUris.add(schemaUri);
      const schemaHandle: JSONSchemaDescriptionExt = {
        uri: schemaUri,
        fromStore: false,
        usedForCurrentFile: false,
      };

      if (this.schemaUriToNameAndDescription.has(schemaUri)) {
        const { name, description, versions } = this.schemaUriToNameAndDescription.get(schemaUri);
        schemaHandle.name = name;
        schemaHandle.description = description;
        schemaHandle.fromStore = true;
        schemaHandle.versions = versions;
      }
      result.push(schemaHandle);
    }

    return result;
  }

  async resolveSchemaContent(
    schemaToResolve: UnresolvedSchema,
    schemaURL: string,
    dependencies: SchemaDependencies
  ): Promise<ResolvedSchema> {
    const resolveErrors: string[] = schemaToResolve.errors.slice(0);
    // Deep clone the schema to prevent mutations from affecting the original schema object
    // This ensures that cached schemas don't get mutated and affect subsequent resolutions
    let schema: JSONSchema = JSON.parse(JSON.stringify(schemaToResolve.schema)) as JSONSchema;
    const contextService = this.contextService;

    const normalizedSchemaUri = this.normalizeId(schema.$schema);
    let validator;
    if (normalizedSchemaUri === ajv4.defaultMeta() || normalizedSchemaUri === SCHEMA_04_URI_WITH_HTTPS) {
      validator = schema04Validator;
    } else if (
      normalizedSchemaUri === SCHEMA_2019_URI ||
      normalizedSchemaUri === SCHEMA_2019_URI_HTTP ||
      normalizedSchemaUri.includes('2019-09')
    ) {
      validator = schema2019Validator;
    } else if (
      normalizedSchemaUri === SCHEMA_2020_URI ||
      normalizedSchemaUri === SCHEMA_2020_URI_HTTP ||
      normalizedSchemaUri.includes('2020-12')
    ) {
      validator = schema2020Validator;
    } else {
      validator = schema07Validator;
    }
    // Ensure validator is defined before calling it
    if (!validator) {
      resolveErrors.push(
        `Schema '${getSchemaTitle(schemaToResolve.schema, schemaURL)}' could not be validated: validator not available for schema version '${normalizedSchemaUri}'`
      );
      return { schema, errors: resolveErrors };
    }
    if (!validator(schema)) {
      const errs: string[] = [];
      for (const err of validator.errors as DefinedError[]) {
        errs.push(`${err.instancePath} : ${err.message}`);
      }
      resolveErrors.push(`Schema '${getSchemaTitle(schemaToResolve.schema, schemaURL)}' is not valid:\n${errs.join('\n')}`);
    }

    /**
     * Resolves a relative $id value relative to a base URI
     * If $id is absolute (starts with scheme://), returns it normalized
     * If $id is relative, resolves it relative to baseURI
     */
    const resolveSchemaId = (schemaId: string | undefined, baseURI: string): string | undefined => {
      if (!schemaId) {
        return undefined;
      }
      // If $id is absolute (has a scheme), normalize and return it
      if (/^\w+:\/\/.*/.test(schemaId)) {
        return this.normalizeId(schemaId);
      }
      // If $id is relative, resolve it relative to baseURI
      if (contextService && baseURI) {
        const resolved = contextService.resolveRelativePath(schemaId, baseURI);
        return this.normalizeId(resolved);
      }
      // Fallback: normalize as-is
      return this.normalizeId(schemaId);
    };

    /**
     * Shared helper functions for traversing schema trees
     */
    const createSchemaTraverser = (
      traverseFn: (schema: JSONSchema, baseURI: string) => void,
      schemaBaseURI: string
    ): {
      collectEntries: (...entries: JSONSchemaRef[]) => void;
      collectMapEntries: (...maps: JSONSchemaMap[]) => void;
      collectArrayEntries: (...arrays: JSONSchemaRef[][]) => void;
    } => {
      const collectEntries = (...entries: JSONSchemaRef[]): void => {
        for (const entry of entries) {
          if (typeof entry === 'object' && entry !== null) {
            traverseFn(entry as JSONSchema, schemaBaseURI);
          }
        }
      };

      const collectMapEntries = (...maps: JSONSchemaMap[]): void => {
        for (const map of maps) {
          if (typeof map === 'object' && map !== null) {
            for (const key in map) {
              const entry = map[key];
              if (typeof entry === 'object' && entry !== null) {
                traverseFn(entry as JSONSchema, schemaBaseURI);
              }
            }
          }
        }
      };

      const collectArrayEntries = (...arrays: JSONSchemaRef[][]): void => {
        for (const array of arrays) {
          if (Array.isArray(array)) {
            for (const entry of array) {
              if (typeof entry === 'object' && entry !== null) {
                traverseFn(entry as JSONSchema, schemaBaseURI);
              }
            }
          }
        }
      };

      return { collectEntries, collectMapEntries, collectArrayEntries };
    };

    /**
     * Generic function to build anchor registries
     * @param anchorType - 'anchor', 'recursiveAnchor', or 'dynamicAnchor'
     * @param preferBaseURI - if true, always use baseURI when provided (for dynamic anchors)
     */
    const buildAnchorRegistryGeneric = (
      anchorType: 'anchor' | 'recursiveAnchor' | 'dynamicAnchor',
      schema: JSONSchema,
      baseURI: string,
      registry: Map<string, JSONSchema> = new Map(),
      visited: Set<JSONSchema> = new Set(),
      preferBaseURI = false
    ): Map<string, JSONSchema> => {
      if (!schema || typeof schema !== 'object' || visited.has(schema)) {
        return registry;
      }
      visited.add(schema);

      // Determine the base URI for this schema
      // If schema has $id, resolve it (handling relative $id values)
      // Otherwise, use the provided baseURI
      let schemaBaseURI: string;
      if (schema.$id) {
        // Resolve $id relative to baseURI (handles both absolute and relative $id)
        const resolvedId = resolveSchemaId(schema.$id, baseURI);
        schemaBaseURI = resolvedId || baseURI;
      } else {
        schemaBaseURI = baseURI;
      }

      // For dynamic anchors with preferBaseURI=true, always use baseURI when provided
      // This ensures consistency with how merge() looks up anchors
      if (preferBaseURI && baseURI) {
        schemaBaseURI = baseURI;
      }

      // Register anchor based on type
      if (anchorType === 'anchor' && schema.$anchor && typeof schema.$anchor === 'string') {
        const anchorKey = schemaBaseURI + '#' + schema.$anchor;
        registry.set(anchorKey, schema);
        registry.set('#' + schema.$anchor, schema);
      } else if (anchorType === 'recursiveAnchor' && schema.$recursiveAnchor !== undefined) {
        if (typeof schema.$recursiveAnchor === 'boolean' && schema.$recursiveAnchor === true) {
          // Draft-07: anonymous recursive anchor
          const anchorKey = schemaBaseURI + '#';
          registry.set(anchorKey, schema);
          registry.set('#', schema);
        } else if (typeof schema.$recursiveAnchor === 'string') {
          // 2019-09: named recursive anchor
          const anchorKey = schemaBaseURI + '#' + schema.$recursiveAnchor;
          registry.set(anchorKey, schema);
          registry.set('#' + schema.$recursiveAnchor, schema);
        }
      } else if (
        anchorType === 'dynamicAnchor' &&
        schema.$dynamicAnchor !== undefined &&
        typeof schema.$dynamicAnchor === 'string'
      ) {
        const anchorKey = schemaBaseURI + '#' + schema.$dynamicAnchor;
        registry.set(anchorKey, schema);
        registry.set('#' + schema.$dynamicAnchor, schema);
      }

      // Recursively traverse schema tree
      const traverseFn = (entry: JSONSchema, baseURI: string): void => {
        buildAnchorRegistryGeneric(anchorType, entry, baseURI, registry, visited, preferBaseURI);
      };

      const { collectEntries, collectMapEntries, collectArrayEntries } = createSchemaTraverser(traverseFn, schemaBaseURI);

      collectEntries(
        <JSONSchema>schema.items,
        schema.additionalItems,
        <JSONSchema>schema.additionalProperties,
        schema.not,
        schema.contains,
        schema.propertyNames,
        schema.if,
        schema.then,
        schema.else,
        schema.unevaluatedItems,
        schema.unevaluatedProperties
      );

      collectMapEntries(
        schema.definitions,
        schema.$defs,
        schema.properties,
        schema.patternProperties,
        <JSONSchemaMap>schema.dependencies
      );

      collectArrayEntries(
        schema.anyOf,
        schema.allOf,
        schema.oneOf,
        <JSONSchemaRef[]>schema.items,
        schema.prefixItems,
        schema.schemaSequence
      );

      return registry;
    };

    /**
     * Builds a registry of all $anchor values in a schema tree
     * Anchors are scoped to their containing schema's base URI (from $id)
     */
    const buildAnchorRegistry = (
      schema: JSONSchema,
      baseURI: string,
      registry: Map<string, JSONSchema> = new Map(),
      visited: Set<JSONSchema> = new Set()
    ): Map<string, JSONSchema> => {
      return buildAnchorRegistryGeneric('anchor', schema, baseURI, registry, visited, false);
    };

    /**
     * Builds a registry of all $recursiveAnchor values in a schema tree
     * Recursive anchors are resolved statically (unlike dynamic anchors)
     * Draft-07: $recursiveAnchor: true creates an anonymous recursive anchor
     * 2019-09: $recursiveAnchor: "name" creates a named recursive anchor
     */
    const buildRecursiveAnchorRegistry = (
      schema: JSONSchema,
      baseURI: string,
      registry: Map<string, JSONSchema> = new Map(),
      visited: Set<JSONSchema> = new Set()
    ): Map<string, JSONSchema> => {
      return buildAnchorRegistryGeneric('recursiveAnchor', schema, baseURI, registry, visited, false);
    };

    /**
     * Builds a registry of all $dynamicAnchor values in a schema tree
     * Dynamic anchors are resolved dynamically during validation (following evaluation path)
     * but for schema resolution, we resolve them statically to the nearest anchor
     * Draft 2020-12: $dynamicAnchor: "name" creates a named dynamic anchor
     */
    const buildDynamicAnchorRegistry = (
      schema: JSONSchema,
      baseURI: string,
      registry: Map<string, JSONSchema> = new Map(),
      visited: Set<JSONSchema> = new Set()
    ): Map<string, JSONSchema> => {
      return buildAnchorRegistryGeneric('dynamicAnchor', schema, baseURI, registry, visited, true);
    };

    const findSection = (
      schema: JSONSchema,
      path: string,
      anchorRegistry?: Map<string, JSONSchema>,
      recursiveAnchorRegistry?: Map<string, JSONSchema>,
      dynamicAnchorRegistry?: Map<string, JSONSchema>,
      schemaURI?: string
    ): JSONSchema => {
      if (!path) {
        return schema;
      }

      // Check if path is an anchor reference (doesn't start with '/')
      if (path[0] !== '/') {
        // Use provided schemaURI, or fall back to schema.url || schema.$id
        // Normalize schema.$id if used to ensure consistency with registry keys
        let resolvedSchemaURI = schemaURI || schema.url || '';
        if (!resolvedSchemaURI && schema.$id) {
          resolvedSchemaURI = this.normalizeId(schema.$id);
        }

        // First try recursive anchor registry (for $recursiveRef)
        if (recursiveAnchorRegistry) {
          // Try with full URI + anchor
          const fullRecursiveAnchorKey = resolvedSchemaURI + '#' + path;
          if (recursiveAnchorRegistry.has(fullRecursiveAnchorKey)) {
            return recursiveAnchorRegistry.get(fullRecursiveAnchorKey);
          }
          // Try with just #anchor (same-document reference)
          const recursiveAnchorKey = '#' + path;
          if (recursiveAnchorRegistry.has(recursiveAnchorKey)) {
            return recursiveAnchorRegistry.get(recursiveAnchorKey);
          }
          // For Draft-07 anonymous recursive anchor, try "#"
          if (path === '' && recursiveAnchorRegistry.has('#')) {
            return recursiveAnchorRegistry.get('#');
          }
        }

        // Then try dynamic anchor registry (for $dynamicRef)
        if (dynamicAnchorRegistry) {
          // Try with full URI + anchor (using provided schemaURI)
          const fullDynamicAnchorKey = resolvedSchemaURI + '#' + path;
          if (dynamicAnchorRegistry.has(fullDynamicAnchorKey)) {
            return dynamicAnchorRegistry.get(fullDynamicAnchorKey);
          }
          // Also try with schema.$id if it's different from resolvedSchemaURI
          if (schema.$id && schema.$id !== resolvedSchemaURI) {
            const normalizedId = this.normalizeId(schema.$id);
            const idBasedKey = normalizedId + '#' + path;
            if (dynamicAnchorRegistry.has(idBasedKey)) {
              return dynamicAnchorRegistry.get(idBasedKey);
            }
          }
          // Try with just #anchor (same-document reference)
          const dynamicAnchorKey = '#' + path;
          if (dynamicAnchorRegistry.has(dynamicAnchorKey)) {
            return dynamicAnchorRegistry.get(dynamicAnchorKey);
          }
        }

        // Then try regular anchor registry (for $ref with $anchor)
        if (anchorRegistry) {
          // Try to resolve as anchor reference
          // First try with full URI + anchor
          const fullAnchorKey = resolvedSchemaURI + '#' + path;
          if (anchorRegistry.has(fullAnchorKey)) {
            return anchorRegistry.get(fullAnchorKey);
          }
          // Then try with just #anchor (same-document reference)
          const anchorKey = '#' + path;
          if (anchorRegistry.has(anchorKey)) {
            return anchorRegistry.get(anchorKey);
          }
        }
      }

      // Fall back to JSON pointer resolution
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let current: any = schema;
      let jsonPointerPath = path;
      if (jsonPointerPath[0] === '/') {
        jsonPointerPath = jsonPointerPath.substr(1);
      }
      jsonPointerPath.split('/').some((part) => {
        current = current[part];
        return !current;
      });
      return current;
    };

    /**
     * Merges schema properties from source to target, excluding schema identification properties
     */
    const mergeSchemaProperties = (target: JSONSchema, source: JSONSchema): void => {
      const excludeKeys = ['$ref', '_$ref', 'url', '$id', '$schema'];
      for (const key in source) {
        if (
          Object.prototype.hasOwnProperty.call(source, key) &&
          !Object.prototype.hasOwnProperty.call(target, key) &&
          !excludeKeys.includes(key)
        ) {
          target[key] = source[key];
        }
      }
    };

    const merge = (
      target: JSONSchema,
      sourceRoot: JSONSchema,
      sourceURI: string,
      path: string,
      anchorRegistry?: Map<string, JSONSchema>,
      recursiveAnchorRegistry?: Map<string, JSONSchema>,
      dynamicAnchorRegistry?: Map<string, JSONSchema>
    ): void => {
      const section = findSection(sourceRoot, path, anchorRegistry, recursiveAnchorRegistry, dynamicAnchorRegistry, sourceURI);
      if (section) {
        mergeSchemaProperties(target, section);
      } else {
        resolveErrors.push(l10n.t('json.schema.invalidref', path, sourceURI));
      }
    };

    const resolveExternalLink = (
      node: JSONSchema,
      uri: string,
      linkPath: string,
      parentSchemaURL: string,
      parentSchemaDependencies: SchemaDependencies,
      anchorRegistry?: Map<string, JSONSchema>,
      recursiveAnchorRegistry?: Map<string, JSONSchema>,
      dynamicAnchorRegistry?: Map<string, JSONSchema>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> => {
      if (contextService && !/^\w+:\/\/.*/.test(uri)) {
        uri = contextService.resolveRelativePath(uri, parentSchemaURL);
      }
      uri = this.normalizeId(uri);
      const referencedHandle = this.getOrAddSchemaHandle(uri);
      return referencedHandle.getUnresolvedSchema().then((unresolvedSchema) => {
        parentSchemaDependencies[uri] = true;
        if (unresolvedSchema.errors.length) {
          const loc = linkPath ? uri + '#' + linkPath : uri;
          resolveErrors.push(l10n.t('json.schema.problemloadingref', loc, unresolvedSchema.errors[0]));
        }
        // Build anchor registry for the external schema
        const externalRegistry = buildAnchorRegistry(unresolvedSchema.schema, uri);
        // Build recursive anchor registry for the external schema
        const externalRecursiveRegistry = buildRecursiveAnchorRegistry(unresolvedSchema.schema, uri);
        // Build dynamic anchor registry for the external schema
        const externalDynamicRegistry = buildDynamicAnchorRegistry(unresolvedSchema.schema, uri);
        // Merge external registries into main registries
        // This ensures both main and external anchors are available for resolution
        if (anchorRegistry) {
          externalRegistry.forEach((value, key) => {
            anchorRegistry.set(key, value);
          });
        }
        if (recursiveAnchorRegistry) {
          externalRecursiveRegistry.forEach((value, key) => {
            recursiveAnchorRegistry.set(key, value);
          });
        }
        if (dynamicAnchorRegistry) {
          externalDynamicRegistry.forEach((value, key) => {
            dynamicAnchorRegistry.set(key, value);
          });
        }
        // Use merged registries (or external if main registries not provided)
        const mergedAnchorRegistry = anchorRegistry || externalRegistry;
        const mergedRecursiveRegistry = recursiveAnchorRegistry || externalRecursiveRegistry;
        const mergedDynamicRegistry = dynamicAnchorRegistry || externalDynamicRegistry;
        merge(node, unresolvedSchema.schema, uri, linkPath, mergedAnchorRegistry, mergedRecursiveRegistry, mergedDynamicRegistry);
        node.url = uri;
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return resolveRefs(
          node,
          unresolvedSchema.schema,
          uri,
          referencedHandle.dependencies,
          anchorRegistry || externalRegistry,
          recursiveAnchorRegistry || externalRecursiveRegistry,
          dynamicAnchorRegistry || externalDynamicRegistry
        );
      });
    };

    const resolveRefs = async (
      node: JSONSchema,
      parentSchema: JSONSchema,
      parentSchemaURL: string,
      parentSchemaDependencies: SchemaDependencies,
      anchorRegistry?: Map<string, JSONSchema>,
      recursiveAnchorRegistry?: Map<string, JSONSchema>,
      dynamicAnchorRegistry?: Map<string, JSONSchema>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> => {
      if (!node || typeof node !== 'object') {
        return null;
      }

      // Determine the effective base URI for this schema
      // If parentSchema has $id, use it (resolved relative to parentSchemaURL)
      // Otherwise, use parentSchemaURL
      const effectiveBaseURI = parentSchema.$id
        ? resolveSchemaId(parentSchema.$id, parentSchemaURL) || parentSchemaURL
        : parentSchemaURL;

      // Build anchor registry if not provided
      const registry = anchorRegistry || buildAnchorRegistry(parentSchema, effectiveBaseURI);
      // Build recursive anchor registry if not provided
      const recursiveRegistry = recursiveAnchorRegistry || buildRecursiveAnchorRegistry(parentSchema, effectiveBaseURI);
      // Build dynamic anchor registry if not provided
      const dynamicRegistry = dynamicAnchorRegistry || buildDynamicAnchorRegistry(parentSchema, effectiveBaseURI);

      const toWalk: JSONSchema[] = [node];
      const seen: Set<JSONSchema> = new Set();
      // Track which schema objects have had their $recursiveRef processed to prevent infinite recursion
      // Format: schema object reference -> Set of processed $recursiveRef values
      const processedRecursiveRefs = new Map<JSONSchema, Set<string>>();
      // Track which schema objects have had their $dynamicRef processed to prevent infinite recursion
      // Format: schema object reference -> Set of processed $dynamicRef values
      const processedDynamicRefs = new Map<JSONSchema, Set<string>>();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const openPromises: Promise<any>[] = [];

      const collectEntries = (...entries: JSONSchemaRef[]): void => {
        for (const entry of entries) {
          if (typeof entry === 'object') {
            toWalk.push(entry);
          }
        }
      };
      const collectMapEntries = (...maps: JSONSchemaMap[]): void => {
        for (const map of maps) {
          if (typeof map === 'object') {
            for (const key in map) {
              const entry = map[key];
              if (typeof entry === 'object') {
                toWalk.push(entry);
              }
            }
          }
        }
      };
      const collectArrayEntries = (...arrays: JSONSchemaRef[][]): void => {
        for (const array of arrays) {
          if (Array.isArray(array)) {
            for (const entry of array) {
              if (typeof entry === 'object') {
                toWalk.push(entry);
              }
            }
          }
        }
      };
      const handleRef = (next: JSONSchema): void => {
        const seenRefs = new Set();
        // Determine base URI for this schema node: use $id if present (resolved relative to effectiveBaseURI), otherwise use effectiveBaseURI
        const currentBaseURI = next.$id ? resolveSchemaId(next.$id, effectiveBaseURI) || effectiveBaseURI : effectiveBaseURI;
        // Handle $ref (static reference)
        while (next.$ref) {
          const ref = decodeURIComponent(next.$ref);
          const segments = ref.split('#', 2);
          //return back removed $ref. We lost info about referenced type without it.
          next._$ref = next.$ref;
          delete next.$ref;
          if (segments[0].length > 0) {
            // Resolve relative URI relative to current schema's base URI (from $id if present)
            let refURI = segments[0];
            if (contextService && !/^\w+:\/\/.*/.test(refURI)) {
              refURI = contextService.resolveRelativePath(refURI, currentBaseURI);
            }
            openPromises.push(
              resolveExternalLink(
                next,
                refURI,
                segments[1],
                currentBaseURI,
                parentSchemaDependencies,
                registry,
                recursiveRegistry,
                dynamicRegistry
              )
            );
            return;
          } else {
            if (!seenRefs.has(ref)) {
              merge(next, parentSchema, currentBaseURI, segments[1], registry, recursiveRegistry, dynamicRegistry); // can set next.$ref again, use seenRefs to avoid circle
              seenRefs.add(ref);
            }
          }
        }
        // Handle $recursiveRef (recursive reference) - resolves statically to nearest $recursiveAnchor
        if (next.$recursiveRef) {
          const ref = decodeURIComponent(next.$recursiveRef);
          const segments = ref.split('#', 2);
          next._$ref = next.$recursiveRef;
          delete next.$recursiveRef;
          if (segments[0].length > 0) {
            // Resolve relative URI relative to current schema's base URI (from $id if present)
            let refURI = segments[0];
            if (contextService && !/^\w+:\/\/.*/.test(refURI)) {
              refURI = contextService.resolveRelativePath(refURI, currentBaseURI);
            }
            openPromises.push(
              resolveExternalLink(
                next,
                refURI,
                segments[1],
                currentBaseURI,
                parentSchemaDependencies,
                registry,
                recursiveRegistry,
                dynamicRegistry
              )
            );
            return;
          } else {
            // Track processed $recursiveRef per schema object to prevent infinite recursion
            // Each schema object can have its $recursiveRef processed once
            // Different schema objects can process the same $recursiveRef value
            if (!seenRefs.has(ref)) {
              const processedRefs = processedRecursiveRefs.get(next) || new Set<string>();
              if (!processedRefs.has(ref)) {
                processedRefs.add(ref);
                processedRecursiveRefs.set(next, processedRefs);
                // For $recursiveRef, use recursive anchor registry to find the schema with matching $recursiveAnchor
                const recursiveAnchorPath = segments[1] || '';
                const recursiveSchema = findSection(
                  parentSchema,
                  recursiveAnchorPath,
                  registry,
                  recursiveRegistry,
                  dynamicRegistry,
                  currentBaseURI
                );
                if (recursiveSchema) {
                  // Merge the recursive anchor schema into the current schema
                  mergeSchemaProperties(next, recursiveSchema);
                  // Collect nested references from merged properties immediately
                  // This ensures nested $recursiveRef and other references are processed
                  collectEntries(
                    <JSONSchema>next.items,
                    next.additionalItems,
                    <JSONSchema>next.additionalProperties,
                    next.not,
                    next.contains,
                    next.propertyNames,
                    next.if,
                    next.then,
                    next.else,
                    next.unevaluatedItems,
                    next.unevaluatedProperties
                  );
                  collectMapEntries(
                    next.definitions,
                    next.$defs,
                    next.properties,
                    next.patternProperties,
                    <JSONSchemaMap>next.dependencies
                  );
                  collectArrayEntries(
                    next.anyOf,
                    next.allOf,
                    next.oneOf,
                    <JSONSchema[]>next.items,
                    next.prefixItems,
                    next.schemaSequence
                  );
                } else {
                  resolveErrors.push(l10n.t('json.schema.invalidref', ref, parentSchemaURL));
                }
              }
              seenRefs.add(ref);
            }
          }
        }
        // Handle $dynamicRef (dynamic reference) - resolves to nearest $dynamicAnchor
        // Note: In JSON Schema 2020-12, $dynamicRef resolves dynamically during validation,
        // but for schema resolution we resolve it statically to the nearest $dynamicAnchor
        if (next.$dynamicRef) {
          const ref = decodeURIComponent(next.$dynamicRef);
          const segments = ref.split('#', 2);
          next._$ref = next.$dynamicRef;
          delete next.$dynamicRef;
          if (segments[0].length > 0) {
            openPromises.push(
              resolveExternalLink(
                next,
                segments[0],
                segments[1],
                parentSchemaURL,
                parentSchemaDependencies,
                registry,
                recursiveRegistry,
                dynamicRegistry
              )
            );
            return;
          } else {
            // Track processed $dynamicRef per schema object to prevent infinite recursion
            // Each schema object can have its $dynamicRef processed once
            // Different schema objects can process the same $dynamicRef value
            if (!seenRefs.has(ref)) {
              const processedRefs = processedDynamicRefs.get(next) || new Set<string>();
              if (!processedRefs.has(ref)) {
                processedRefs.add(ref);
                processedDynamicRefs.set(next, processedRefs);
                // For $dynamicRef, use dynamic anchor registry to find the schema with matching $dynamicAnchor
                const dynamicAnchorPath = segments[1] || '';
                const dynamicSchema = findSection(
                  parentSchema,
                  dynamicAnchorPath,
                  registry,
                  recursiveRegistry,
                  dynamicRegistry,
                  currentBaseURI
                );
                if (dynamicSchema) {
                  // Merge the dynamic anchor schema into the current schema
                  mergeSchemaProperties(next, dynamicSchema);
                  // Continue processing to resolve any nested references (including nested $dynamicRef)
                  // The seen Set prevents re-processing the same schema object, preventing infinite loops
                  if (!seen.has(next)) {
                    toWalk.push(next);
                  }
                } else {
                  resolveErrors.push(l10n.t('json.schema.invalidref', ref, parentSchemaURL));
                }
              }
              seenRefs.add(ref);
            }
          }
        }

        collectEntries(
          <JSONSchema>next.items,
          next.additionalItems,
          <JSONSchema>next.additionalProperties,
          next.not,
          next.contains,
          next.propertyNames,
          next.if,
          next.then,
          next.else,
          next.unevaluatedItems,
          next.unevaluatedProperties
        );
        // Handle both definitions (draft-07) and $defs (2019-09/2020-12)
        collectMapEntries(
          next.definitions,
          next.$defs,
          next.properties,
          next.patternProperties,
          <JSONSchemaMap>next.dependencies
        );
        collectArrayEntries(next.anyOf, next.allOf, next.oneOf, <JSONSchema[]>next.items, next.prefixItems, next.schemaSequence);
      };

      if (parentSchemaURL.indexOf('#') > 0) {
        const segments = parentSchemaURL.split('#', 2);
        if (segments[0].length > 0 && segments[1].length > 0) {
          const newSchema = {};
          await resolveExternalLink(
            newSchema,
            segments[0],
            segments[1],
            parentSchemaURL,
            parentSchemaDependencies,
            registry,
            recursiveRegistry,
            dynamicRegistry
          );
          for (const key in schema) {
            if (key === 'required') {
              continue;
            }
            if (Object.prototype.hasOwnProperty.call(schema, key) && !Object.prototype.hasOwnProperty.call(newSchema, key)) {
              newSchema[key] = schema[key];
            }
          }
          schema = newSchema;
        }
      }

      while (toWalk.length) {
        const next = toWalk.pop();
        if (seen.has(next)) {
          continue;
        }
        seen.add(next);
        handleRef(next);
      }
      return Promise.all(openPromises);
    };

    await resolveRefs(schema, schema, schemaURL, dependencies);

    // Merge allOf entries into the root schema after resolution
    // allOf means "all schemas in this array must be valid", which in practice means merging them
    // However, we should only merge when:
    // 1. The root schema has other properties (not just allOf) - indicating it's a single schema with allOf
    // 2. The allOf entries reference $defs within the same schema (via $ref starting with #/$defs)
    // We should NOT merge when allOf contains separate schemas from different sources (combined schemas)
    if (
      schema.allOf &&
      Array.isArray(schema.allOf) &&
      Object.keys(schema).length > 1 // Root schema has properties beyond just allOf
    ) {
      for (const allOfItem of schema.allOf) {
        if (typeof allOfItem === 'object' && allOfItem !== null) {
          const allOfSchema = allOfItem as JSONSchema;
          // Only merge if the allOf entry has been resolved (no $ref, only _$ref if any)
          // AND it references $defs within the same schema (indicated by _$ref starting with #/$defs)
          const shouldMerge =
            !allOfSchema.$ref && (allOfSchema._$ref?.startsWith('#/$defs') || allOfSchema._$ref?.startsWith('#/definitions'));
          if (shouldMerge) {
            // Merge properties from allOf entry into root schema
            mergeSchemaProperties(schema, allOfSchema);
            // Merge properties object if both exist
            if (allOfSchema.properties && schema.properties) {
              for (const propKey in allOfSchema.properties) {
                if (!Object.prototype.hasOwnProperty.call(schema.properties, propKey)) {
                  schema.properties[propKey] = allOfSchema.properties[propKey];
                }
              }
            } else if (allOfSchema.properties && !schema.properties) {
              schema.properties = allOfSchema.properties;
            }
          }
        }
      }
    }

    return new ResolvedSchema(schema, resolveErrors);
  }

  public getSchemaForResource(resource: string, doc: JSONDocument): Promise<ResolvedSchema> {
    const resolveModelineSchema = (): string | undefined => {
      let schemaFromModeline = getSchemaFromModeline(doc);
      if (schemaFromModeline !== undefined) {
        if (!schemaFromModeline.startsWith('file:') && !schemaFromModeline.startsWith('http')) {
          // If path contains a fragment and it is left intact, "#" will be
          // considered part of the filename and converted to "%23" by
          // path.resolve() -> take it out and add back after path.resolve
          let appendix = '';
          if (schemaFromModeline.indexOf('#') > 0) {
            const segments = schemaFromModeline.split('#', 2);
            schemaFromModeline = segments[0];
            appendix = segments[1];
          }
          if (!path.isAbsolute(schemaFromModeline)) {
            const resUri = URI.parse(resource);
            schemaFromModeline = URI.file(path.resolve(path.parse(resUri.fsPath).dir, schemaFromModeline)).toString();
          } else {
            schemaFromModeline = URI.file(schemaFromModeline).toString();
          }
          if (appendix.length > 0) {
            schemaFromModeline += '#' + appendix;
          }
        }
        return schemaFromModeline;
      }
    };

    const resolveSchemaForResource = (schemas: string[]): Promise<ResolvedSchema> => {
      const schemaHandle = super.createCombinedSchema(resource, schemas);
      return schemaHandle.getResolvedSchema().then((schema) => {
        if (schema.schema && typeof schema.schema === 'object') {
          schema.schema.url = schemaHandle.url;
        }

        if (
          schema.schema &&
          schema.schema.schemaSequence &&
          schema.schema.schemaSequence[(<SingleYAMLDocument>doc).currentDocIndex]
        ) {
          return new ResolvedSchema(schema.schema.schemaSequence[(<SingleYAMLDocument>doc).currentDocIndex]);
        }
        return schema;
      });
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveSchema = (): any => {
      const seen: { [schemaId: string]: boolean } = Object.create(null);
      const schemas: string[] = [];

      for (const entry of this.filePatternAssociations) {
        if (entry.matchesPattern(resource)) {
          for (const schemaId of entry.getURIs()) {
            if (!seen[schemaId]) {
              schemas.push(schemaId);
              seen[schemaId] = true;
            }
          }
        }
      }

      if (schemas.length > 0) {
        // Join all schemas with the highest priority.
        const highestPrioSchemas = this.highestPrioritySchemas(schemas);
        return resolveSchemaForResource(highestPrioSchemas);
      }

      return Promise.resolve(null);
    };
    const modelineSchema = resolveModelineSchema();
    if (modelineSchema) {
      return resolveSchemaForResource([modelineSchema]);
    }
    if (this.customSchemaProvider) {
      return this.customSchemaProvider(resource)
        .then((schemaUri) => {
          if (Array.isArray(schemaUri)) {
            if (schemaUri.length === 0) {
              return resolveSchema();
            }
            return Promise.all(
              schemaUri.map((schemaUri) => {
                return this.resolveCustomSchema(schemaUri, doc);
              })
            ).then(
              (schemas) => {
                return {
                  errors: [],
                  schema: {
                    allOf: schemas.map((schemaObj) => {
                      return schemaObj.schema;
                    }),
                  },
                };
              },
              () => {
                return resolveSchema();
              }
            );
          }

          if (!schemaUri) {
            return resolveSchema();
          }

          return this.resolveCustomSchema(schemaUri, doc);
        })
        .then(
          (schema) => {
            return schema;
          },
          () => {
            return resolveSchema();
          }
        );
    } else {
      return resolveSchema();
    }
  }

  // Set the priority of a schema in the schema service
  public addSchemaPriority(uri: string, priority: number): void {
    let currSchemaArray = this.schemaPriorityMapping.get(uri);
    if (currSchemaArray) {
      currSchemaArray = currSchemaArray.add(priority);
      this.schemaPriorityMapping.set(uri, currSchemaArray);
    } else {
      this.schemaPriorityMapping.set(uri, new Set<SchemaPriority>().add(priority));
    }
  }

  /**
   * Search through all the schemas and find the ones with the highest priority
   */
  private highestPrioritySchemas(schemas: string[]): string[] {
    let highestPrio = 0;
    const priorityMapping = new Map<SchemaPriority, string[]>();
    schemas.forEach((schema) => {
      // If the schema does not have a priority then give it a default one of [0]
      const priority = this.schemaPriorityMapping.get(schema) || [0];
      priority.forEach((prio) => {
        if (prio > highestPrio) {
          highestPrio = prio;
        }

        // Build up a mapping of priority to schemas so that we can easily get the highest priority schemas easier
        let currPriorityArray = priorityMapping.get(prio);
        if (currPriorityArray) {
          currPriorityArray = (currPriorityArray as string[]).concat(schema);
          priorityMapping.set(prio, currPriorityArray);
        } else {
          priorityMapping.set(prio, [schema]);
        }
      });
    });
    return priorityMapping.get(highestPrio) || [];
  }

  private async resolveCustomSchema(schemaUri, doc): ResolvedSchema {
    const unresolvedSchema = await this.loadSchema(schemaUri);
    const schema = await this.resolveSchemaContent(unresolvedSchema, schemaUri, []);
    if (schema.schema && typeof schema.schema === 'object') {
      schema.schema.url = schemaUri;
    }
    if (schema.schema && schema.schema.schemaSequence && schema.schema.schemaSequence[doc.currentDocIndex]) {
      return new ResolvedSchema(schema.schema.schemaSequence[doc.currentDocIndex], schema.errors);
    }
    return schema;
  }

  /**
   * Save a schema with schema ID and schema content.
   * Overrides previous schemas set for that schema ID.
   */
  public async saveSchema(schemaId: string, schemaContent: JSONSchema): Promise<void> {
    const id = this.normalizeId(schemaId);
    this.getOrAddSchemaHandle(id, schemaContent);
    this.schemaPriorityMapping.set(id, new Set<SchemaPriority>().add(SchemaPriority.Settings));
    return Promise.resolve(undefined);
  }

  /**
   * Delete schemas on specific path
   */
  public async deleteSchemas(deletions: SchemaDeletionsAll): Promise<void> {
    deletions.schemas.forEach((s) => {
      this.deleteSchema(s);
    });
    return Promise.resolve(undefined);
  }
  /**
   * Delete a schema with schema ID.
   */
  public async deleteSchema(schemaId: string): Promise<void> {
    const id = this.normalizeId(schemaId);
    if (this.schemasById[id]) {
      delete this.schemasById[id];
    }
    this.schemaPriorityMapping.delete(id);
    return Promise.resolve(undefined);
  }

  /**
   * Add content to a specified schema at a specified path
   */
  public async addContent(additions: SchemaAdditions): Promise<void> {
    const schema = await this.getResolvedSchema(additions.schema);
    if (schema) {
      const resolvedSchemaLocation = this.resolveJSONSchemaToSection(schema.schema, additions.path);

      if (typeof resolvedSchemaLocation === 'object') {
        resolvedSchemaLocation[additions.key] = additions.content;
      }
      await this.saveSchema(additions.schema, schema.schema);
    }
  }

  /**
   * Delete content in a specified schema at a specified path
   */
  public async deleteContent(deletions: SchemaDeletions): Promise<void> {
    const schema = await this.getResolvedSchema(deletions.schema);
    if (schema) {
      const resolvedSchemaLocation = this.resolveJSONSchemaToSection(schema.schema, deletions.path);

      if (typeof resolvedSchemaLocation === 'object') {
        delete resolvedSchemaLocation[deletions.key];
      }
      await this.saveSchema(deletions.schema, schema.schema);
    }
  }

  /**
   * Take a JSON Schema and the path that you would like to get to
   * @returns the JSON Schema resolved at that specific path
   */
  private resolveJSONSchemaToSection(schema: JSONSchema, paths: string): JSONSchema {
    const splitPathway = paths.split('/');
    let resolvedSchemaLocation = schema;
    for (const path of splitPathway) {
      if (path === '') {
        continue;
      }
      this.resolveNext(resolvedSchemaLocation, path);
      resolvedSchemaLocation = resolvedSchemaLocation[path];
    }
    return resolvedSchemaLocation;
  }

  /**
   * Resolve the next Object if they have compatible types
   * @param object a location in the JSON Schema
   * @param token the next token that you want to search for
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveNext(object: any, token: any): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (Array.isArray(object) && isNaN(token)) {
      throw new Error('Expected a number after the array object');
    } else if (typeof object === 'object' && typeof token !== 'string') {
      throw new Error('Expected a string after the object');
    }
  }

  /**
   * Everything below here is needed because we're importing from vscode-json-languageservice umd and we need
   * to provide a wrapper around the javascript methods we are calling since they have no type
   */

  normalizeId(id: string): string {
    // The parent's `super.normalizeId(id)` isn't visible, so duplicated the code here
    try {
      return URI.parse(id).toString();
    } catch (e) {
      return id;
    }
  }

  /*
   * Everything below here is needed because we're importing from vscode-json-languageservice umd and we need
   * to provide a wrapper around the javascript methods we are calling since they have no type
   */

  getOrAddSchemaHandle(id: string, unresolvedSchemaContent?: JSONSchema): SchemaHandle {
    return super.getOrAddSchemaHandle(id, unresolvedSchemaContent);
  }

  loadSchema(schemaUri: string): Promise<UnresolvedSchema> {
    const requestService = this.requestService;
    return super.loadSchema(schemaUri).then(async (unresolvedJsonSchema: UnresolvedSchema) => {
      // If json-language-server failed to parse the schema, attempt to parse it as YAML instead.
      // If the YAML file starts with %YAML 1.x or contains a comment with a number the schema will
      // contain a number instead of being undefined, so we need to check for that too.
      if (
        unresolvedJsonSchema.errors &&
        (unresolvedJsonSchema.schema === undefined || typeof unresolvedJsonSchema.schema === 'number')
      ) {
        return requestService(schemaUri).then(
          (content) => {
            if (!content) {
              const errorMessage = l10n.t(
                'json.schema.nocontent',
                "Unable to load schema from '{0}': No content. {1}",
                toDisplayString(schemaUri),
                unresolvedJsonSchema.errors
              );
              return new UnresolvedSchema(<JSONSchema>{}, [errorMessage]);
            }

            try {
              const schemaContent = parse(content);
              return new UnresolvedSchema(schemaContent, []);
            } catch (yamlError) {
              const errorMessage = l10n.t(
                'json.schema.invalidFormat',
                "Unable to parse content from '{0}': {1}.",
                toDisplayString(schemaUri),
                yamlError
              );
              return new UnresolvedSchema(<JSONSchema>{}, [errorMessage]);
            }
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (error: any) => {
            let errorMessage = error.toString();
            const errorSplit = error.toString().split('Error: ');
            if (errorSplit.length > 1) {
              // more concise error message, URL and context are attached by caller anyways
              errorMessage = errorSplit[1];
            }
            return new UnresolvedSchema(<JSONSchema>{}, [errorMessage]);
          }
        );
      }
      unresolvedJsonSchema.uri = schemaUri;
      if (this.schemaUriToNameAndDescription.has(schemaUri)) {
        const { name, description, versions } = this.schemaUriToNameAndDescription.get(schemaUri);
        unresolvedJsonSchema.schema.title = name ?? unresolvedJsonSchema.schema.title;
        unresolvedJsonSchema.schema.description = description ?? unresolvedJsonSchema.schema.description;
        unresolvedJsonSchema.schema.versions = versions ?? unresolvedJsonSchema.schema.versions;
      } else if (unresolvedJsonSchema.errors && unresolvedJsonSchema.errors.length > 0) {
        let errorMessage: string = unresolvedJsonSchema.errors[0];
        if (errorMessage.toLowerCase().indexOf('load') !== -1) {
          errorMessage = l10n.t('json.schema.noContent', toDisplayString(schemaUri));
        } else if (errorMessage.toLowerCase().indexOf('parse') !== -1) {
          const content = await requestService(schemaUri);
          const jsonErrors: Json.ParseError[] = [];
          const schemaContent = Json.parse(content, jsonErrors);
          if (jsonErrors.length && schemaContent) {
            const { offset } = jsonErrors[0];
            const { line, column } = getLineAndColumnFromOffset(content, offset);
            errorMessage = l10n.t('json.schema.invalidFormat', toDisplayString(schemaUri), line, column);
          }
        }
        return new UnresolvedSchema(<JSONSchema>{}, [errorMessage]);
      }
      return unresolvedJsonSchema;
    });
  }

  registerExternalSchema(
    uri: string,
    filePatterns?: string[],
    unresolvedSchema?: JSONSchema,
    name?: string,
    description?: string,
    versions?: SchemaVersions
  ): SchemaHandle {
    if (name || description) {
      this.schemaUriToNameAndDescription.set(uri, { name, description, versions });
    }
    return super.registerExternalSchema(uri, filePatterns, unresolvedSchema);
  }

  clearExternalSchemas(): void {
    super.clearExternalSchemas();
  }

  setSchemaContributions(schemaContributions: ISchemaContributions): void {
    super.setSchemaContributions(schemaContributions);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRegisteredSchemaIds(filter?: (scheme: any) => boolean): string[] {
    return super.getRegisteredSchemaIds(filter);
  }

  getResolvedSchema(schemaId: string): Promise<ResolvedSchema> {
    return super.getResolvedSchema(schemaId);
  }

  onResourceChange(uri: string): boolean {
    const normalizedUri = this.normalizeId(uri);
    const result = super.onResourceChange(normalizedUri);

    // Clear the cache for this schema URI to ensure anchor registries are rebuilt
    // Anchor registries are built fresh during schema resolution, so clearing
    // the cache forces them to be rebuilt with the latest schema content
    // Note: For schemas managed by custom schema providers, you must also update/delete
    // them from the provider, as deleting the handle will cause a new handle to be
    // created that will query the provider again. If the provider still has the old
    // schema, the new handle will load the stale schema.
    if (this.schemasById && this.schemasById[normalizedUri]) {
      delete this.schemasById[normalizedUri];
    }

    // Also clear any schemas that might reference this schema via anchors
    // This ensures that when a schema changes, dependent schemas also get
    // their anchor registries rebuilt
    if (this.schemasById) {
      for (const schemaId in this.schemasById) {
        const handle = this.schemasById[schemaId];
        if (handle && handle.dependencies && handle.dependencies[normalizedUri]) {
          // This schema depends on the changed schema, clear its cache too
          delete this.schemasById[schemaId];
        }
      }
    }

    return result;
  }
}

function toDisplayString(url: string): string {
  try {
    const uri = URI.parse(url);
    if (uri.scheme === 'file') {
      return uri.fsPath;
    }
  } catch (e) {
    // ignore
  }
  return url;
}

function getLineAndColumnFromOffset(text: string, offset: number): { line: number; column: number } {
  const lines = text.slice(0, offset).split(/\r?\n/);
  const line = lines.length; // 1-based line number
  const column = lines[lines.length - 1].length + 1; // 1-based column number
  return { line, column };
}
