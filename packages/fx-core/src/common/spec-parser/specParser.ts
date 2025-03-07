// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
"use strict";

import SwaggerParser from "@apidevtools/swagger-parser";
import { OpenAPIV3 } from "openapi-types";
import converter from "swagger2openapi";
import jsyaml from "js-yaml";
import fs from "fs-extra";
import path from "path";
import {
  APIInfo,
  ErrorType,
  GenerateResult,
  ListAPIResult,
  ParseOptions,
  ValidateResult,
  ValidationStatus,
  WarningType,
} from "./interfaces";
import { ConstantString } from "./constants";
import { SpecParserError } from "./specParserError";
import { specFilter } from "./specFilter";
import {
  convertPathToCamelCase,
  getAPIKeyAuthArray,
  listSupportedAPIs,
  validateSpec,
} from "./utils";
import { updateManifest } from "./manifestUpdater";
import { generateAdaptiveCard } from "./adaptiveCardGenerator";
import { wrapAdaptiveCard } from "./adaptiveCardWrapper";

/**
 * A class that parses an OpenAPI specification file and provides methods to validate, list, and generate artifacts.
 */
export class SpecParser {
  public readonly pathOrSpec: string | OpenAPIV3.Document;
  public readonly parser: SwaggerParser;
  public readonly options: Required<ParseOptions>;

  private apiMap: { [key: string]: OpenAPIV3.PathItemObject } | undefined;
  private spec: OpenAPIV3.Document | undefined;
  private unResolveSpec: OpenAPIV3.Document | undefined;
  private isSwaggerFile: boolean | undefined;

  private defaultOptions: ParseOptions = {
    allowMissingId: true,
    allowSwagger: true,
    allowAPIKeyAuth: false,
    allowMultipleParameters: false,
  };

  /**
   * Creates a new instance of the SpecParser class.
   * @param pathOrDoc The path to the OpenAPI specification file or the OpenAPI specification object.
   * @param options The options for parsing the OpenAPI specification file.
   */
  constructor(pathOrDoc: string | OpenAPIV3.Document, options?: ParseOptions) {
    this.pathOrSpec = pathOrDoc;
    this.parser = new SwaggerParser();
    this.options = {
      ...this.defaultOptions,
      ...(options ?? {}),
    } as Required<ParseOptions>;
  }

  /**
   * Validates the OpenAPI specification file and returns a validation result.
   *
   * @returns A validation result object that contains information about any errors or warnings in the specification file.
   */
  async validate(): Promise<ValidateResult> {
    try {
      try {
        await this.loadSpec();
        await this.parser.validate(this.spec!);
      } catch (e) {
        return {
          status: ValidationStatus.Error,
          warnings: [],
          errors: [{ type: ErrorType.SpecNotValid, content: (e as Error).toString() }],
        };
      }

      if (!this.options.allowSwagger && this.isSwaggerFile) {
        return {
          status: ValidationStatus.Error,
          warnings: [],
          errors: [
            { type: ErrorType.SwaggerNotSupported, content: ConstantString.SwaggerNotSupported },
          ],
        };
      }

      return validateSpec(
        this.spec!,
        this.parser,
        !!this.isSwaggerFile,
        this.options.allowMissingId,
        this.options.allowAPIKeyAuth,
        this.options.allowMultipleParameters
      );
    } catch (err) {
      throw new SpecParserError((err as Error).toString(), ErrorType.ValidateFailed);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listSupportedAPIInfo(): Promise<APIInfo[]> {
    throw new Error("Method not implemented.");
  }

  /**
   * Lists all the OpenAPI operations in the specification file.
   * @returns A string array that represents the HTTP method and path of each operation, such as ['GET /pets/{petId}', 'GET /user/{userId}']
   * according to copilot plugin spec, only list get and post method without auth
   */
  async list(): Promise<ListAPIResult[]> {
    try {
      await this.loadSpec();
      const spec = this.spec!;
      const apiMap = this.getAllSupportedAPIs(spec);
      const result: ListAPIResult[] = [];
      for (const apiKey in apiMap) {
        const apiResult: ListAPIResult = {
          api: "",
          server: "",
          operationId: "",
        };
        const [method, path] = apiKey.split(" ");
        const operation = apiMap[apiKey];
        const rootServer = spec.servers && spec.servers[0];
        const methodServer = spec.paths[path]!.servers && spec.paths[path]?.servers![0];
        const operationServer = operation.servers && operation.servers[0];

        const serverUrl = operationServer || methodServer || rootServer;
        if (!serverUrl) {
          throw new SpecParserError(
            ConstantString.NoServerInformation,
            ErrorType.NoServerInformation
          );
        }

        apiResult.server = serverUrl.url;

        let operationId = operation.operationId;
        if (!operationId) {
          operationId = `${method.toLowerCase()}${convertPathToCamelCase(path)}`;
        }
        apiResult.operationId = operationId;

        const apiKeyAuthArray = getAPIKeyAuthArray(operation.security, spec);

        for (const apiKeyAuth of apiKeyAuthArray) {
          if (apiKeyAuth.length === 1) {
            apiResult.auth = apiKeyAuth[0];
            break;
          }
        }

        apiResult.api = apiKey;
        result.push(apiResult);
      }

      return result;
    } catch (err) {
      if (err instanceof SpecParserError) {
        throw err;
      }
      throw new SpecParserError((err as Error).toString(), ErrorType.ListFailed);
    }
  }

  /**
   * Generates and update artifacts from the OpenAPI specification file. Generate Adaptive Cards, update Teams app manifest, and generate a new OpenAPI specification file.
   * @param manifestPath A file path of the Teams app manifest file to update.
   * @param filter An array of strings that represent the filters to apply when generating the artifacts. If filter is empty, it would process nothing.
   * @param outputSpecPath File path of the new OpenAPI specification file to generate. If not specified or empty, no spec file will be generated.
   * @param adaptiveCardFolder Folder path where the Adaptive Card files will be generated. If not specified or empty, Adaptive Card files will not be generated.
   */
  async generate(
    manifestPath: string,
    filter: string[],
    outputSpecPath: string,
    adaptiveCardFolder: string,
    signal?: AbortSignal
  ): Promise<GenerateResult> {
    const result: GenerateResult = {
      allSuccess: true,
      warnings: [],
    };
    try {
      if (signal?.aborted) {
        throw new SpecParserError(ConstantString.CancelledMessage, ErrorType.Cancelled);
      }

      await this.loadSpec();
      if (signal?.aborted) {
        throw new SpecParserError(ConstantString.CancelledMessage, ErrorType.Cancelled);
      }

      const newUnResolvedSpec = specFilter(
        filter,
        this.unResolveSpec!,
        this.spec!,
        this.options.allowMissingId,
        this.options.allowAPIKeyAuth,
        this.options.allowMultipleParameters
      );

      if (signal?.aborted) {
        throw new SpecParserError(ConstantString.CancelledMessage, ErrorType.Cancelled);
      }

      const newSpec = (await this.parser.dereference(newUnResolvedSpec)) as OpenAPIV3.Document;

      const operationIdToAPIAuthKey: Map<string, OpenAPIV3.ApiKeySecurityScheme> = new Map();
      let hasMultipleAPIKeyAuth = false;
      let firstAuthKey: OpenAPIV3.ApiKeySecurityScheme | undefined;

      for (const url in newSpec.paths) {
        for (const method in newSpec.paths[url]) {
          const operation = (newSpec.paths[url] as any)[method] as OpenAPIV3.OperationObject;

          const apiKeyAuthArr = getAPIKeyAuthArray(operation.security, newSpec);

          // Currently we don't support multiple apiKey auth
          if (apiKeyAuthArr.length > 0 && apiKeyAuthArr.every((auths) => auths.length > 1)) {
            hasMultipleAPIKeyAuth = true;
            break;
          }

          if (apiKeyAuthArr && apiKeyAuthArr.length > 0) {
            if (!firstAuthKey) {
              firstAuthKey = apiKeyAuthArr[0][0];
            } else if (firstAuthKey.name !== apiKeyAuthArr[0][0].name) {
              hasMultipleAPIKeyAuth = true;
              break;
            }
            operationIdToAPIAuthKey.set(operation.operationId!, apiKeyAuthArr[0][0]);
          }
        }
      }

      if (hasMultipleAPIKeyAuth) {
        throw new SpecParserError(
          ConstantString.MultipleAPIKeyNotSupported,
          ErrorType.MultipleAPIKeyNotSupported
        );
      }

      let resultStr;
      if (outputSpecPath.endsWith(".yaml") || outputSpecPath.endsWith(".yml")) {
        resultStr = jsyaml.dump(newUnResolvedSpec);
      } else {
        resultStr = JSON.stringify(newUnResolvedSpec, null, 2);
      }
      await fs.outputFile(outputSpecPath, resultStr);

      for (const url in newSpec.paths) {
        for (const method in newSpec.paths[url]) {
          const operation = (newSpec.paths[url] as any)[method] as OpenAPIV3.OperationObject;

          try {
            const [card, jsonPath] = generateAdaptiveCard(operation);
            const fileName = path.join(adaptiveCardFolder, `${operation.operationId!}.json`);
            const wrappedCard = wrapAdaptiveCard(card, jsonPath);
            await fs.outputJSON(fileName, wrappedCard, { spaces: 2 });
          } catch (err) {
            result.allSuccess = false;
            result.warnings.push({
              type: WarningType.GenerateCardFailed,
              content: (err as Error).toString(),
              data: operation.operationId!,
            });
          }
        }
      }

      if (signal?.aborted) {
        throw new SpecParserError(ConstantString.CancelledMessage, ErrorType.Cancelled);
      }

      const [updatedManifest, warnings] = await updateManifest(
        manifestPath,
        outputSpecPath,
        adaptiveCardFolder,
        newSpec,
        this.options.allowMultipleParameters,
        firstAuthKey?.name
      );

      await fs.outputJSON(manifestPath, updatedManifest, { spaces: 2 });

      result.warnings.push(...warnings);
    } catch (err) {
      if (err instanceof SpecParserError) {
        throw err;
      }
      throw new SpecParserError((err as Error).toString(), ErrorType.GenerateFailed);
    }

    return result;
  }

  private async loadSpec(): Promise<void> {
    if (!this.spec) {
      this.unResolveSpec = (await this.parser.parse(this.pathOrSpec)) as OpenAPIV3.Document;
      // Convert swagger 2.0 to openapi 3.0
      if (!this.unResolveSpec.openapi && (this.unResolveSpec as any).swagger === "2.0") {
        const specObj = await converter.convert(this.unResolveSpec as any, {});
        this.unResolveSpec = specObj.openapi as OpenAPIV3.Document;
        this.isSwaggerFile = true;
      }

      const clonedUnResolveSpec = JSON.parse(JSON.stringify(this.unResolveSpec));
      this.spec = (await this.parser.dereference(clonedUnResolveSpec)) as OpenAPIV3.Document;
    }
  }

  private getAllSupportedAPIs(spec: OpenAPIV3.Document): {
    [key: string]: OpenAPIV3.OperationObject;
  } {
    if (this.apiMap !== undefined) {
      return this.apiMap;
    }
    const result = listSupportedAPIs(
      spec,
      this.options.allowMissingId,
      this.options.allowAPIKeyAuth,
      this.options.allowMultipleParameters
    );
    this.apiMap = result;
    return result;
  }
}
