// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
"use strict";

import { OpenAPIV3 } from "openapi-types";
import { convertPathToCamelCase, isSupportedApi } from "./utils";
import { SpecParserError } from "./specParserError";
import { ErrorType } from "./interfaces";
import { ConstantString } from "./constants";

export function specFilter(
  filter: string[],
  unResolveSpec: OpenAPIV3.Document,
  resolvedSpec: OpenAPIV3.Document,
  allowMissingId: boolean,
  allowAPIKeyAuth: boolean,
  allowMultipleParameters: boolean
): OpenAPIV3.Document {
  try {
    const newSpec = { ...unResolveSpec };
    const newPaths: OpenAPIV3.PathsObject = {};
    for (const filterItem of filter) {
      const [method, path] = filterItem.split(" ");
      const methodName = method.toLowerCase();

      if (
        !isSupportedApi(
          methodName,
          path,
          resolvedSpec,
          allowMissingId,
          allowAPIKeyAuth,
          allowMultipleParameters
        )
      ) {
        continue;
      }

      if (!newPaths[path]) {
        newPaths[path] = { ...unResolveSpec.paths[path] };
        for (const m of ConstantString.AllOperationMethods) {
          delete (newPaths[path] as any)[m];
        }
      }

      (newPaths[path] as any)[methodName] = (unResolveSpec.paths[path] as any)[methodName];

      // Add the operationId if missing
      if (!(newPaths[path] as any)[methodName].operationId) {
        (newPaths[path] as any)[methodName].operationId = `${methodName}${convertPathToCamelCase(
          path
        )}`;
      }
    }

    newSpec.paths = newPaths;
    return newSpec;
  } catch (err) {
    throw new SpecParserError((err as Error).toString(), ErrorType.FilterSpecFailed);
  }
}
