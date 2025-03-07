// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  AppPackageFolderName,
  ConfigFolderName,
  FxError,
  Result,
  TemplateFolderName,
  ok,
} from "@microsoft/teamsfx-api";
import { AzureScopes } from "@microsoft/teamsfx-core/build/common/tools";
import { dotenvUtil } from "@microsoft/teamsfx-core/src/component/utils/envUtil";
import { exec } from "child_process";
import * as dotenv from "dotenv";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { YAMLMap, YAMLSeq, parseDocument } from "yaml";
import MockAzureAccountProvider from "@microsoft/teamsapp-cli/src/commonlib/azureLoginUserPassword";
import m365Login from "@microsoft/teamsapp-cli/src/commonlib/m365Login";
import {
  AadManager,
  AadValidator,
  AppStudioValidator,
  BotValidator,
  FrontendValidator,
  ResourceGroupManager,
  SharepointValidator as SharepointManager,
  cfg,
} from "../commonlib";
import {
  PluginId,
  ProjectSettingKey,
  StateConfigKey,
  TestFilePath,
  fileEncoding,
} from "../commonlib/constants";
import { getWebappServicePlan } from "../commonlib/utilities";

export const TEN_MEGA_BYTE = 1024 * 1024 * 10;
export const execAsync = promisify(exec);

export async function execAsyncWithRetry(
  command: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
  retries = 3,
  newCommand?: string
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  while (retries > 0) {
    retries--;
    try {
      const result = await execAsync(command, options);
      return result;
    } catch (e: any) {
      console.log(
        `Run \`${command}\` failed with error msg: ${JSON.stringify(e)}.`
      );
      if (e.killed && e.signal == "SIGTERM") {
        console.log(`Command ${command} killed due to timeout`);
      }
      if (newCommand) {
        command = newCommand;
      }
      await sleep(10000);
    }
  }
  return execAsync(command, options);
}

const testFolder = path.resolve(os.homedir(), "test-folder");

export function getTestFolder() {
  if (!fs.pathExistsSync(testFolder)) {
    fs.mkdirSync(testFolder);
  }
  return testFolder;
}

export function getAppNamePrefix() {
  return "fxE2E";
}

export function getUniqueAppName() {
  return getAppNamePrefix() + Date.now().toString() + uuidv4().slice(0, 2);
}

export function convertToAlphanumericOnly(appName: string): string {
  return appName.replace(/[^\da-zA-Z]/g, "");
}

export function getSubscriptionId() {
  return cfg.AZURE_SUBSCRIPTION_ID || "";
}

export function getAzureTenantId() {
  return cfg.AZURE_TENANT_ID || "";
}

export function getAzureAccountObjectId() {
  if (!cfg.AZURE_ACCOUNT_OBJECT_ID) {
    throw new Error("Failed to get AZURE_ACCOUNT_OBJECT_ID from environment.");
  }
  return cfg.AZURE_ACCOUNT_OBJECT_ID;
}

const envFilePathSuffix = path.join(".fx", "env.default.json");

function getEnvFilePathSuffix(envName: string) {
  return path.join(".fx", "states", `state.${envName}.json`);
}

export function getConfigFileName(appName: string, envName = "dev"): string {
  return path.resolve(testFolder, appName, getEnvFilePathSuffix(envName));
}

export async function setProvisionParameterValueV3(
  projectPath: string,
  envName: string,
  paramerters: { key: string; value: string }
): Promise<void> {
  const parametersFilePath = path.resolve(
    projectPath,
    "infra",
    `azure.parameters.json`
  );
  const parameters = await fs.readJson(parametersFilePath);
  parameters["parameters"][paramerters.key] = { value: paramerters.value };
  return await fs.writeJson(parametersFilePath, parameters, { spaces: 4 });
}

export async function setProvisionParameterValue(
  projectPath: string,
  envName: string,
  paramerters: { key: string; value: string }
): Promise<void> {
  const parametersFilePath = path.resolve(
    projectPath,
    TestFilePath.configFolder,
    `azure.parameters.${envName}.json`
  );
  const parameters = await fs.readJSON(parametersFilePath);
  parameters["parameters"]["provisionParameters"]["value"][paramerters.key] =
    paramerters.value;
  return fs.writeJSON(parametersFilePath, parameters, { spaces: 4 });
}

export async function setBotSkuNameToB1Bicep(
  projectPath: string,
  filePath = ""
) {
  const azureParametersFilePathSuffix = filePath
    ? path.join(filePath)
    : path.join("infra", "azure.parameters.json");
  const azureParametersFilePath = path.resolve(
    projectPath,
    azureParametersFilePathSuffix
  );
  const ProvisionParameters = await fs.readJSON(azureParametersFilePath);
  ProvisionParameters["parameters"]["provisionParameters"]["value"][
    "botWebAppSKU"
  ] = "B1";
  return fs.writeJSON(azureParametersFilePath, ProvisionParameters, {
    spaces: 4,
  });
}

export async function setSimpleAuthSkuNameToB1(projectPath: string) {
  const envFilePath = path.resolve(projectPath, envFilePathSuffix);
  const context = await fs.readJSON(envFilePath);
  context[PluginId.SimpleAuth][StateConfigKey.skuName] = "B1";
  return fs.writeJSON(envFilePath, context, { spaces: 4 });
}

export async function setSimpleAuthSkuNameToB1Bicep(
  projectPath: string,
  envName: string
): Promise<void> {
  const parameters = { key: "simpleAuthSku", value: "B1" };
  return setProvisionParameterValueV3(projectPath, envName, parameters);
}

export async function getProvisionParameterValueByKey(
  projectPath: string,
  envName: string,
  key: string
): Promise<string | undefined> {
  const parameters = await fs.readJSON(
    path.join(
      projectPath,
      TestFilePath.configFolder,
      `azure.parameters.${envName}.json`
    )
  );
  if (
    parameters.parameters &&
    parameters.parameters.provisionParameters &&
    parameters.parameters.provisionParameters.value &&
    parameters.parameters.provisionParameters.value[key]
  ) {
    return parameters.parameters.provisionParameters.value[key];
  }
  return undefined;
}

export async function setBotSkuNameToB1(projectPath: string) {
  const envFilePath = path.resolve(projectPath, envFilePathSuffix);
  const context = await fs.readJSON(envFilePath);
  context[PluginId.Bot][StateConfigKey.skuName] = "B1";
  return fs.writeJSON(envFilePath, context, { spaces: 4 });
}

export async function setSkipAddingSqlUser(projectPath: string) {
  const envFilePath = path.resolve(projectPath, envFilePathSuffix);
  const context = await fs.readJSON(envFilePath);
  context[PluginId.AzureSQL][StateConfigKey.skipAddingUser] = true;
  return fs.writeJSON(envFilePath, context, { spaces: 4 });
}

export async function setSkipAddingSqlUserToConfig(
  projectPath: string,
  envName: string
) {
  const configFile = path.join(
    `.${ConfigFolderName}`,
    "configs",
    `config.${envName}.json`
  );
  const configFilePath = path.resolve(projectPath, configFile);
  const config = await fs.readJSON(configFilePath);
  config["skipAddingSqlUser"] = true;
  return fs.writeJSON(configFilePath, config, { spaces: 4 });
}

export async function setFrontendDomainToConfig(
  projectPath: string,
  envName: string
) {
  const configFile = path.join(
    `.${ConfigFolderName}`,
    "configs",
    `config.${envName}.json`
  );
  const configFilePath = path.resolve(projectPath, configFile);
  const config = await fs.readJSON(configFilePath);
  config["auth"] = {};
  config["auth"]["frontendDomain"] = "xxx.com";
  return fs.writeJSON(configFilePath, config, { spaces: 4 });
}

export async function setAadManifestIdentifierUrisV3(
  projectPath: string,
  identifierUri: string
) {
  const aadManifestPath = path.join(projectPath, "aad.manifest.json");
  const aadTemplate = await fs.readJson(aadManifestPath);
  aadTemplate.identifierUris = [identifierUri];
  await fs.writeJson(aadManifestPath, aadTemplate, { spaces: 4 });
}

export async function setAadManifestIdentifierUris(
  projectPath: string,
  identifierUri: string
) {
  const aadManifestPath = path.join(
    projectPath,
    `${TemplateFolderName}/${AppPackageFolderName}/aad.template.json`
  );

  const aadTemplate = await fs.readJSON(aadManifestPath);
  aadTemplate.identifierUris = [identifierUri];
  await fs.writeJSON(aadManifestPath, aadTemplate, { spaces: 4 });
}

export async function cleanupSharePointPackage(appId: string) {
  if (appId) {
    try {
      SharepointManager.init();
      await SharepointManager.deleteApp(appId);
      console.log(`[Successfully] clean up sharepoint package ${appId}`);
    } catch (error: any) {
      console.log(
        `[Failed] clean up sharepoint package ${appId}, Error: ${error.message}`
      );
    }
  } else {
    console.log(
      `[Failed] sharepoint appId is undefined, will not clean up this resource.`
    );
  }
}

export async function cleanUpAadApp(
  projectPath: string,
  hasAadPlugin?: boolean,
  hasBotPlugin?: boolean,
  hasApimPlugin?: boolean,
  envName = "dev"
) {
  const envFilePath = path.resolve(projectPath, getEnvFilePathSuffix(envName));
  if (!(await fs.pathExists(envFilePath))) {
    return;
  }
  const context = await fs.readJSON(envFilePath);
  const manager = await AadManager.init();
  const promises: Promise<boolean>[] = [];

  const clean = async (objectId?: string) => {
    return new Promise<boolean>(async (resolve) => {
      if (objectId) {
        const result = await manager.deleteAadAppById(objectId);
        if (result) {
          console.log(
            `[Successfully] clean up the Aad app with id: ${objectId}.`
          );
        } else {
          console.error(`[Failed] clean up the Aad app with id: ${objectId}.`);
        }
        return resolve(result);
      }
      return resolve(false);
    });
  };

  if (hasAadPlugin) {
    const objectId = context[PluginId.Aad].objectId;
    promises.push(clean(objectId));
  }

  if (hasBotPlugin) {
    const objectId = context[PluginId.Bot].objectId;
    promises.push(clean(objectId));
  }

  if (hasApimPlugin) {
    const objectId = context[PluginId.Apim].apimClientAADObjectId;
    promises.push(clean(objectId));
  }

  return Promise.all(promises);
}

export async function cleanUpResourceGroup(
  appName: string,
  envName?: string
): Promise<boolean> {
  if (!appName) {
    return false;
  }
  const name = `${appName}-${envName}-rg`;
  return await deleteResourceGroupByName(name);
}

export async function deleteResourceGroupByName(
  name: string
): Promise<boolean> {
  if (!name) {
    return true;
  }
  if (await ResourceGroupManager.hasResourceGroup(name)) {
    const result = await ResourceGroupManager.deleteResourceGroup(name);
    if (result) {
      console.log(
        `[Successfully] clean up the Azure resource group with name: ${name}.`
      );
    } else {
      console.error(
        `[Failed] clean up the Azure resource group with name: ${name}.`
      );
    }
    return result;
  }
  return false;
}

export async function cleanUpLocalProject(
  projectPath: string,
  necessary?: Promise<any>
) {
  return new Promise<boolean>(async (resolve) => {
    try {
      await necessary;
      await fs.remove(projectPath);
      console.log(`[Successfully] clean up the local folder: ${projectPath}.`);
      return resolve(true);
    } catch (e) {
      console.log(
        `[Failed] clean up the local folder: ${projectPath}. error = '${e}'`
      );
      return resolve(false);
    }
  });
}

export async function cleanUp(
  appName: string,
  projectPath: string,
  hasAadPlugin = true,
  hasBotPlugin = false,
  hasApimPlugin = false,
  envName = "dev",
  teamsAppId?: string
) {
  const cleanUpAadAppPromise = cleanUpAadApp(
    projectPath,
    hasAadPlugin,
    hasBotPlugin,
    hasApimPlugin,
    envName
  );
  return Promise.all([
    // delete aad app
    cleanUpAadAppPromise,
    // remove resouce group
    cleanUpResourceGroup(appName, envName),
    // remove project
    cleanUpLocalProject(projectPath, cleanUpAadAppPromise),
    // cancel stagged app
    AppStudioValidator.cancelStagedAppInTeamsAppCatalog(teamsAppId),
  ]);
}

export async function createResourceGroup(name: string, location: string) {
  const result = await ResourceGroupManager.createOrUpdateResourceGroup(
    name,
    location
  );
  if (result) {
    console.log(`[Successfully] create resource group ${name}.`);
  } else {
    console.error(`[Failed] failed to create resource group ${name}.`);
  }
  return result;
}

// TODO: add encrypt
export async function readContext(projectPath: string): Promise<any> {
  const userDataFilePath = `${projectPath}/.fx/default.userdata`;

  // Read Context and UserData
  const context = await fs.readJSON(`${projectPath}/.fx/env.default.json`);

  let userData: Record<string, string> = {};
  if (await fs.pathExists(userDataFilePath)) {
    const dictContent = await fs.readFile(userDataFilePath, "UTF-8");
    userData = dotenv.parse(dictContent);
  }

  // Read from userdata.
  for (const plugin in context) {
    const pluginContext = context[plugin];
    for (const key in pluginContext) {
      if (
        typeof pluginContext[key] === "string" &&
        isSecretPattern(pluginContext[key])
      ) {
        const secretKey = `${plugin}.${key}`;
        pluginContext[key] = userData[secretKey] ?? undefined;
      }
    }
  }

  return context;
}

export async function readContextMultiEnvV3(
  projectPath: string,
  envName: string
): Promise<any> {
  const envFilePath = path.join(projectPath, "env", `.env.${envName}`);
  const parseResult = dotenvUtil.deserialize(
    await fs.readFile(envFilePath, { encoding: "utf8" })
  );
  return parseResult.obj;
}

export async function readContextMultiEnv(
  projectPath: string,
  envName: string
): Promise<any> {
  const contextFilePath = `${projectPath}/.fx/states/state.${envName}.json`;
  const userDataFilePath = `${projectPath}/.fx/states/${envName}.userdata`;

  // Read Context and UserData
  const context = await fs.readJSON(contextFilePath);

  let userData: Record<string, string> = {};
  if (await fs.pathExists(userDataFilePath)) {
    const dictContent = await fs.readFile(userDataFilePath, "UTF-8");
    userData = dotenv.parse(dictContent);
  }

  // Read from userdata.
  for (const plugin in context) {
    const pluginContext = context[plugin];
    for (const key in pluginContext) {
      if (
        typeof pluginContext[key] === "string" &&
        isSecretPattern(pluginContext[key])
      ) {
        const secretKey = `${plugin}.${key}`;
        pluginContext[key] = userData[secretKey] ?? undefined;
      }
    }
  }
}

export async function getActivePluginsFromProjectSetting(
  projectPath: string
): Promise<any> {
  const projectSettings = await fs.readJSON(
    path.join(
      projectPath,
      TestFilePath.configFolder,
      TestFilePath.projectSettingsFileName
    )
  );
  return projectSettings[ProjectSettingKey.solutionSettings][
    ProjectSettingKey.activeResourcePlugins
  ];
}

export async function getCapabilitiesFromProjectSetting(
  projectPath: string
): Promise<any> {
  const projectSettings = await fs.readJSON(
    path.join(
      projectPath,
      TestFilePath.configFolder,
      TestFilePath.projectSettingsFileName
    )
  );
  return projectSettings[ProjectSettingKey.solutionSettings][
    ProjectSettingKey.capabilities
  ];
}

export function mockTeamsfxMultiEnvFeatureFlag() {
  const env = Object.assign({}, process.env);
  env["TEAMSFX_BICEP_ENV_CHECKER_ENABLE"] = "true";
  env["__TEAMSFX_INSIDER_PREVIEW"] = "true";
  return env;
}

function isSecretPattern(value: string) {
  console.log(value);
  return value.startsWith("{{") && value.endsWith("}}");
}

// Load envProfile with userdata (not decrypted)
export async function loadContext(
  projectPath: string,
  env: string
): Promise<Result<any, FxError>> {
  const context = await fs.readJson(
    path.join(
      projectPath,
      `.${ConfigFolderName}`,
      "states",
      `state.${env}.json`
    )
  );
  const userDataFile = path.join(
    projectPath,
    `.${ConfigFolderName}`,
    "states",
    `${env}.userdata`
  );
  if (await fs.pathExists(userDataFile)) {
    const userdataContent = await fs.readFile(userDataFile, "utf8");
    const userdata = dotenv.parse(userdataContent);
    const regex = /\{\{([^{}]+)\}\}/;
    for (const component in context) {
      for (const key in context[component]) {
        const matchResult = regex.exec(context[component][key]);
        if (matchResult) {
          const userdataKey = matchResult[1];
          if (userdataKey in userdata) {
            context[component][key] = userdata[userdataKey];
          }
        }
      }
    }
  }

  return ok(context);
}

export async function customizeBicepFilesToCustomizedRg(
  customizedRgName: string,
  projectPath: string,
  provisionInsertionSearchStrings: string[] | string,
  configInsertionSearchStrings?: string[] | string
): Promise<void> {
  const provisionFilePath = path.join(
    projectPath,
    TestFilePath.armTemplateBaseFolder,
    TestFilePath.provisionFileName
  );
  const paramToAdd = `param customizedRg string = '${customizedRgName}'\r\n`;
  const scopeToAdd = `scope: resourceGroup(customizedRg)\r\n`;

  let content = await fs.readFile(provisionFilePath, fileEncoding);
  content = paramToAdd + content;

  const searchStrings: string[] = [];
  searchStrings
    .concat(provisionInsertionSearchStrings)
    .forEach((searchString) => {
      const insertionIndex = content.indexOf(searchString);
      content =
        content.substring(0, insertionIndex) +
        scopeToAdd +
        content.substring(insertionIndex);
    });

  await fs.writeFile(provisionFilePath, content);
  console.log(
    `[Successfully] customize ${provisionFilePath} content to deploy cloud resources to ${customizedRgName}.`
  );

  if (configInsertionSearchStrings) {
    const configFilePath = path.join(
      projectPath,
      TestFilePath.armTemplateBaseFolder,
      TestFilePath.configFileName
    );
    let content = await fs.readFile(configFilePath, fileEncoding);
    content = paramToAdd + content;

    const searchStrings: string[] = [];
    searchStrings
      .concat(configInsertionSearchStrings)
      .forEach((searchString) => {
        const insertionIndex = content.indexOf(searchString);
        content =
          content.substring(0, insertionIndex) +
          scopeToAdd +
          content.substring(insertionIndex);
      });

    await fs.writeFile(configFilePath, content);
    console.log(
      `[Successfully] customize ${configFilePath} content to deploy cloud resources to ${customizedRgName}.`
    );
  }
}

export async function validateTabAndBotProjectProvision(
  projectPath: string,
  env: string
) {
  const context = await readContextMultiEnvV3(projectPath, env);
  // Validate Aad App
  const aad = AadValidator.init(context, false, m365Login);
  await AadValidator.validate(aad);

  // Validate Tab Frontend
  const frontend = FrontendValidator.init(context);
  await FrontendValidator.validateProvision(frontend);

  // Validate Bot Provision
  const bot = new BotValidator(context, projectPath, env);
  await bot.validateProvisionV3();
}

export async function getRGAfterProvision(
  projectPath: string,
  env: string
): Promise<string | undefined> {
  const context = await readContextMultiEnv(projectPath, env);
  if (
    context[PluginId.Solution] &&
    context[PluginId.Solution][StateConfigKey.resourceGroupName]
  ) {
    return context[PluginId.Solution][StateConfigKey.resourceGroupName];
  }
  return undefined;
}

export async function customizeBicepFile(
  projectPath: string
): Promise<string[]> {
  const newServerFarms: string[] = [];
  const bicepFileFolder = path.join(
    projectPath,
    TestFilePath.armTemplateBaseFolder
  );

  const pattern = "SERVER_FARM_NAME";
  const customizedServerFarmsBicepTemplate = `
resource customizedServerFarms 'Microsoft.Web/serverfarms@2021-02-01' = {
name: '${pattern}'
location: resourceGroup().location
sku: {
  name: 'B1'
}
kind: 'app'
properties: {}
}
`;
  const frontendHostingTestServerFarm = "frontendhosting_testResource";
  await fs.appendFile(
    path.join(
      bicepFileFolder,
      TestFilePath.provisionFolder,
      "azureStorageTab.bicep"
    ),
    customizedServerFarmsBicepTemplate.replace(
      pattern,
      frontendHostingTestServerFarm
    )
  );
  newServerFarms.push(frontendHostingTestServerFarm);

  const provisionTestServerFarm = "provision_testResource";
  await fs.appendFile(
    path.join(bicepFileFolder, TestFilePath.provisionFileName),
    customizedServerFarmsBicepTemplate.replace(pattern, provisionTestServerFarm)
  );
  newServerFarms.push(provisionTestServerFarm);

  const configTestServerFarm = "config_testResource";
  await fs.appendFile(
    path.join(bicepFileFolder, TestFilePath.configFileName),
    customizedServerFarmsBicepTemplate.replace(pattern, configTestServerFarm)
  );
  newServerFarms.push(configTestServerFarm);

  const mainTestServerFarm = "main_testResource";
  await fs.appendFile(
    path.join(bicepFileFolder, TestFilePath.mainFileName),
    customizedServerFarmsBicepTemplate.replace(pattern, mainTestServerFarm)
  );
  newServerFarms.push(mainTestServerFarm);

  return newServerFarms;
}

export async function validateServicePlan(
  servicePlanName: string,
  resourceGroup: string,
  subscription: string
) {
  console.log(`Start to validate server farm ${servicePlanName}.`);

  const tokenProvider = MockAzureAccountProvider;
  const tokenCredential = await tokenProvider.getIdentityCredentialAsync();
  const token = (await tokenCredential?.getToken(AzureScopes))?.token;

  const serivcePlanResponse = await getWebappServicePlan(
    subscription,
    resourceGroup,
    servicePlanName,
    token as string
  );
  chai.assert(serivcePlanResponse, "B1");
}

export function getKeyVaultSecretReference(
  vaultName: string,
  secretName: string
): string {
  return `@Microsoft.KeyVault(VaultName=${vaultName};SecretName=${secretName})`;
}

export function editDotEnvFile(
  filePath: string,
  key: string,
  value: string
): void {
  try {
    const envFileContent: string = fs.readFileSync(filePath, "utf-8");
    const envVars: { [key: string]: string } = envFileContent
      .split("\n")
      .reduce((acc: { [key: string]: string }, line: string) => {
        const [key, value] = line.split("=");
        if (key && value) {
          acc[key.trim()] = value.trim();
        }
        return acc;
      }, {});
    envVars[key] = value;
    const newEnvFileContent: string = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    fs.writeFileSync(filePath, newEnvFileContent);
  } catch (error) {
    console.log('Failed to edit ".env" file.');
  }
}

export function removeTeamsAppExtendToM365(filePath: string) {
  try {
    const yamlFileContent = fs.readFileSync(filePath, "utf-8");
    const appYaml = parseDocument(yamlFileContent);
    if (!appYaml.has("provision")) {
      return;
    }

    const provisionStage = appYaml.get("provision") as YAMLSeq;
    for (let i = 0; i < provisionStage.items?.length; ++i) {
      const action = provisionStage.items?.[i] as YAMLMap;
      if (
        action.commentBefore &&
        action.commentBefore?.includes(
          "Extend your Teams app to Outlook and the Microsoft 365 app"
        )
      ) {
        provisionStage.delete(i);
      }
    }

    fs.writeFileSync(filePath, appYaml.toString());
  } catch (error: any) {
    console.log(
      `Failed to remove teamsApp/extendToM365 action due to: ${error.message}`
    );
  }
}
