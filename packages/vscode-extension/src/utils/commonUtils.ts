// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { exec } from "child_process";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { format } from "util";
import * as vscode from "vscode";

import { ConfigFolderName, SubscriptionInfo } from "@microsoft/teamsfx-api";
import {
  PluginNames,
  initializePreviewFeatureFlags,
  isValidProject,
} from "@microsoft/teamsfx-core";
import * as extensionPackage from "../../package.json";
import { CONFIGURATION_PREFIX, ConfigurationKey } from "../constants";
import * as commonUtils from "../debug/commonUtils";
import { getV3TeamsAppId } from "../debug/commonUtils";
import * as globalVariables from "../globalVariables";
import { core } from "../handlers";
import { TelemetryProperty, TelemetryTriggerFrom } from "../telemetry/extTelemetryEvents";
import { glob } from "glob";

export function getPackageVersion(versionStr: string): string {
  if (versionStr.includes("alpha")) {
    return "alpha";
  }

  if (versionStr.includes("beta")) {
    return "beta";
  }

  if (versionStr.includes("rc")) {
    return "rc";
  }

  return "formal";
}

export function isFeatureFlag(): boolean {
  return extensionPackage.featureFlag === "true";
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));

  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function isWindows() {
  return os.type() === "Windows_NT";
}

export function isMacOS() {
  return os.type() === "Darwin";
}

export function isLinux() {
  return os.type() === "Linux";
}

export interface TeamsAppTelemetryInfo {
  appId: string;
  tenantId: string;
}

// Only used for telemetry when multi-env is enabled
export async function getTeamsAppTelemetryInfoByEnv(
  env: string
): Promise<TeamsAppTelemetryInfo | undefined> {
  try {
    const ws = globalVariables.workspaceUri!.fsPath;
    if (isValidProject(ws)) {
      const projectInfoRes = await core.getProjectInfo(ws, env);
      if (projectInfoRes.isOk()) {
        const projectInfo = projectInfoRes.value;
        return {
          appId: projectInfo.teamsAppId,
          tenantId: projectInfo.m365TenantId,
        };
      }
    }
  } catch (e) {}
  return undefined;
}

export async function getProjectId(): Promise<string | undefined> {
  if (!globalVariables.workspaceUri) {
    return undefined;
  }
  try {
    const ws = globalVariables.workspaceUri.fsPath;
    const projInfoRes = await core.getProjectId(ws);
    if (projInfoRes.isOk()) {
      return projInfoRes.value;
    }
  } catch (e) {}
  return undefined;
}

export async function getAppName(): Promise<string | undefined> {
  if (!globalVariables.workspaceUri) {
    return undefined;
  }
  try {
    const ws = globalVariables.workspaceUri.fsPath;
    const nameRes = await core.getTeamsAppName(ws);
    if (nameRes.isOk() && nameRes.value != "") {
      return nameRes.value;
    }
  } catch (e) {}
  return undefined;
}

export function openFolderInExplorer(folderPath: string): void {
  const command = format('start "" "%s"', folderPath);
  exec(command);
}

export async function isM365Project(workspacePath: string): Promise<boolean> {
  const projectSettingsPath = path.resolve(
    workspacePath,
    `.${ConfigFolderName}`,
    "configs",
    "projectSettings.json"
  );

  if (await fs.pathExists(projectSettingsPath)) {
    const projectSettings = await fs.readJson(projectSettingsPath);
    return projectSettings.isM365;
  } else {
    return false;
  }
}

export function anonymizeFilePaths(stack?: string): string {
  if (stack === undefined || stack === null) {
    return "";
  }

  const cleanupPatterns: RegExp[] = [];

  let updatedStack = stack;

  const cleanUpIndexes: [number, number][] = [];

  for (const regexp of cleanupPatterns) {
    while (true) {
      const result = regexp.exec(stack);

      if (!result) {
        break;
      }

      cleanUpIndexes.push([result.index, regexp.lastIndex]);
    }
  }

  const nodeModulesRegex = /^[\\\/]?(node_modules|node_modules\.asar)[\\\/]/;

  const fileRegex =
    /(file:\/\/)?([a-zA-Z]:(\\\\|\\|\/)|(\\\\|\\|\/))?([\w-\._]+(\\\\|\\|\/))+[\w-\._]*/g;

  let lastIndex = 0;

  updatedStack = "";

  while (true) {
    const result = fileRegex.exec(stack);

    if (!result) {
      break;
    }

    // Anoynimize user file paths that do not need to be retained or cleaned up.

    if (
      !nodeModulesRegex.test(result[0]) &&
      cleanUpIndexes.every(([x, y]) => result.index < x || result.index >= y)
    ) {
      updatedStack += stack.substring(lastIndex, result.index) + "<REDACTED: user-file-path>";

      lastIndex = fileRegex.lastIndex;
    }
  }

  if (lastIndex < stack.length) {
    updatedStack += stack.substr(lastIndex);
  }

  // sanitize with configured cleanup patterns

  for (const regexp of cleanupPatterns) {
    updatedStack = updatedStack.replace(regexp, "");
  }

  return updatedStack;
}

export function getConfiguration(key: string): boolean {
  const configuration: vscode.WorkspaceConfiguration =
    vscode.workspace.getConfiguration(CONFIGURATION_PREFIX);

  return configuration.get<boolean>(key, false);
}

export function syncFeatureFlags() {
  process.env["TEAMSFX_BICEP_ENV_CHECKER_ENABLE"] = getConfiguration(
    ConfigurationKey.BicepEnvCheckerEnable
  ).toString();

  process.env["DEVELOP_COPILOT_PLUGIN"] = getConfiguration(
    ConfigurationKey.CopilotPluginEnable
  ).toString();

  initializePreviewFeatureFlags();
}

export class FeatureFlags {
  static readonly InsiderPreview = "__TEAMSFX_INSIDER_PREVIEW";
  static readonly TelemetryTest = "TEAMSFX_TELEMETRY_TEST";
  static readonly DevTunnelTest = "TEAMSFX_DEV_TUNNEL_TEST";
  static readonly Preview = "TEAMSFX_PREVIEW";
}

// Determine whether feature flag is enabled based on environment variable setting

export function isFeatureFlagEnabled(featureFlagName: string, defaultValue = false): boolean {
  const flag = process.env[featureFlagName];

  if (flag === undefined) {
    return defaultValue; // allows consumer to set a default value when environment variable not set
  } else {
    return flag === "1" || flag.toLowerCase() === "true"; // can enable feature flag by set environment variable value to "1" or "true"
  }
}

export function getAllFeatureFlags(): string[] | undefined {
  const result = Object.values(FeatureFlags)

    .filter((featureFlag: string) => {
      return isFeatureFlagEnabled(featureFlag);
    })

    .map((featureFlag) => {
      return featureFlag;
    });

  return result;
}

export async function getSubscriptionInfoFromEnv(
  env: string
): Promise<SubscriptionInfo | undefined> {
  let provisionResult: Record<string, any> | undefined;

  try {
    provisionResult = await getProvisionResultJson(env);
  } catch (error) {
    // ignore error on tree view when load provision result failed.

    return undefined;
  }

  if (!provisionResult) {
    return undefined;
  }

  if (provisionResult.solution && provisionResult.solution.subscriptionId) {
    return {
      subscriptionName: provisionResult.solution.subscriptionName,

      subscriptionId: provisionResult.solution.subscriptionId,

      tenantId: provisionResult.solution.tenantId,
    };
  } else {
    return undefined;
  }
}

export async function getM365TenantFromEnv(env: string): Promise<string | undefined> {
  let provisionResult: Record<string, any> | undefined;

  try {
    provisionResult = await getProvisionResultJson(env);
  } catch (error) {
    // ignore error on tree view when load provision result failed.
    return undefined;
  }

  if (!provisionResult) {
    return undefined;
  }

  return provisionResult?.[PluginNames.SOLUTION]?.teamsAppTenantId;
}

export async function getResourceGroupNameFromEnv(env: string): Promise<string | undefined> {
  let provisionResult: Record<string, any> | undefined;

  try {
    provisionResult = await getProvisionResultJson(env);
  } catch (error) {
    // ignore error on tree view when load provision result failed.

    return undefined;
  }

  if (!provisionResult) {
    return undefined;
  }

  return provisionResult.solution?.resourceGroupName;
}

export async function getProvisionSucceedFromEnv(env: string): Promise<boolean | undefined> {
  // If TEAMS_APP_ID is set, it's highly possible that the project is provisioned.
  try {
    const teamsAppId = await getV3TeamsAppId(globalVariables.workspaceUri!.fsPath, env);
    return teamsAppId !== "";
  } catch (error) {
    return false;
  }
}

async function getProvisionResultJson(env: string): Promise<Record<string, string> | undefined> {
  if (globalVariables.workspaceUri) {
    if (!globalVariables.isTeamsFxProject) {
      return undefined;
    }

    const configRoot = await commonUtils.getProjectRoot(
      globalVariables.workspaceUri.fsPath,
      `.${ConfigFolderName}`
    );

    const provisionOutputFile = path.join(configRoot!, path.join("states", `state.${env}.json`));

    if (!fs.existsSync(provisionOutputFile)) {
      return undefined;
    }

    const provisionResult = await fs.readJSON(provisionOutputFile);

    return provisionResult;
  }
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTriggerFromWalkThrough(args?: any[]): boolean {
  if (!args || (args && args.length === 0)) {
    return false;
  } else if (
    (args[0] as TelemetryTriggerFrom).toString() === TelemetryTriggerFrom.WalkThrough ||
    (args[0] as TelemetryTriggerFrom).toString() === TelemetryTriggerFrom.Notification
  ) {
    return true;
  }

  return false;
}

export function getTriggerFromProperty(args?: any[]) {
  // if not args are not supplied, by default, it is trigger from "CommandPalette"
  // e.g. vscode.commands.executeCommand("fx-extension.openWelcome");
  // in this case, "fx-exentiosn.openWelcome" is trigged from "CommandPalette".
  if (!args || (args && args.length === 0) || !args[0]) {
    return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.CommandPalette };
  }

  switch ((args[0] as TelemetryTriggerFrom).toString()) {
    case TelemetryTriggerFrom.TreeView:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.TreeView };
    case TelemetryTriggerFrom.ViewTitleNavigation:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.ViewTitleNavigation };
    case TelemetryTriggerFrom.QuickPick:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.QuickPick };
    case TelemetryTriggerFrom.Webview:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.Webview };
    case TelemetryTriggerFrom.CodeLens:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.CodeLens };
    case TelemetryTriggerFrom.EditorTitle:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.EditorTitle };
    case TelemetryTriggerFrom.SideBar:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.SideBar };
    case TelemetryTriggerFrom.Notification:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.Notification };
    case TelemetryTriggerFrom.WalkThrough:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.WalkThrough };
    case TelemetryTriggerFrom.Auto:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.Auto };
    case TelemetryTriggerFrom.Other:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.Other };
    default:
      return { [TelemetryProperty.TriggerFrom]: TelemetryTriggerFrom.Unknow };
  }
}

export async function hasAdaptiveCardInWorkspace(): Promise<boolean> {
  // Skip large files which are unlikely to be adaptive cards to prevent performance impact.
  const fileSizeLimit = 1024 * 1024;

  if (globalVariables.workspaceUri) {
    const files = await glob(globalVariables.workspaceUri.path + "/**/*.json", {
      ignore: ["**/node_modules/**", "./node_modules/**"],
    });
    for (const file of files) {
      let content = "";
      let fd = -1;
      try {
        fd = await fs.open(file, "r");
        const stat = await fs.fstat(fd);
        // limit file size to prevent performance impact
        if (stat.size > fileSizeLimit) {
          continue;
        }

        // avoid security issue
        // https://github.com/OfficeDev/TeamsFx/security/code-scanning/2664
        const buffer = new Uint8Array(fileSizeLimit);
        const { bytesRead } = await fs.read(fd, buffer, 0, buffer.byteLength, 0);
        content = new TextDecoder().decode(buffer.slice(0, bytesRead));
      } catch (e) {
        // skip invalid files
        continue;
      } finally {
        if (fd >= 0) {
          fs.close(fd).catch(() => {});
        }
      }

      if (isAdaptiveCard(content)) {
        return true;
      }
    }
  }

  return false;
}

function isAdaptiveCard(content: string): boolean {
  const pattern = /"type"\s*:\s*"AdaptiveCard"/;
  return pattern.test(content);
}
