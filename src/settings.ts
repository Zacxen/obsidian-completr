import { Vault } from "obsidian";

export const enum WordInsertionMode {
    MATCH_CASE_REPLACE = "Match-Case & Replace",
    IGNORE_CASE_REPLACE = "Ignore-Case & Replace",
    IGNORE_CASE_APPEND = "Ignore-Case & Append"
}

export const enum CalloutProviderSource {
    COMPLETR = "Completr",
    CALLOUT_MANAGER = "Callout Manager",
}

export interface CompletrSettings {
    characterRegex: string,
    maxLookBackDistance: number,
    autoFocus: boolean,
    autoTrigger: boolean,
    minWordLength: number,
    minWordTriggerLength: number,
    wordInsertionMode: WordInsertionMode,
    ignoreDiacriticsWhenFiltering: boolean,
    insertSpaceAfterComplete: boolean,
    insertPeriodAfterSpaces: boolean,
    latexProviderEnabled: boolean,
    latexTriggerInCodeBlocks: boolean,
    latexMinWordTriggerLength: number,
    latexIgnoreCase: boolean,
    fileScannerProviderEnabled: boolean,
    fileScannerScanCurrent: boolean,
    wordListProviderEnabled: boolean,
    frontMatterProviderEnabled: boolean,
    frontMatterTagAppendSuffix: boolean,
    frontMatterIgnoreCase: boolean,
    calloutProviderEnabled: boolean,
    calloutProviderSource: CalloutProviderSource,
    llmProviderEnabled: boolean,
    llmApiUrl: string,
    llmApiKey: string,
    llmModel: string,
    llmTemperature: number,
    llmRequestTimeout: number,
}

export const DEFAULT_SETTINGS: CompletrSettings = {
    characterRegex: "a-zA-ZöäüÖÄÜß",
    maxLookBackDistance: 50,
    autoFocus: true,
    autoTrigger: true,
    minWordLength: 2,
    minWordTriggerLength: 3,
    wordInsertionMode: WordInsertionMode.IGNORE_CASE_REPLACE,
    ignoreDiacriticsWhenFiltering: false,
    insertSpaceAfterComplete: false,
    insertPeriodAfterSpaces: false,
    latexProviderEnabled: true,
    latexTriggerInCodeBlocks: true,
    latexMinWordTriggerLength: 2,
    latexIgnoreCase: false,
    fileScannerProviderEnabled: true,
    fileScannerScanCurrent: true,
    wordListProviderEnabled: true,
    frontMatterProviderEnabled: true,
    frontMatterTagAppendSuffix: true,
    frontMatterIgnoreCase: true,
    calloutProviderEnabled: true,
    calloutProviderSource: CalloutProviderSource.COMPLETR,
    llmProviderEnabled: true,
    llmApiUrl: "http://127.0.0.1:5000/v1/chat/completions",
    llmApiKey: "",
    llmModel: "",
    llmTemperature: 0.7,
    llmRequestTimeout: 10000,
}

export function intoCompletrPath(vault: Vault, ...path: string[]): string {
    return vault.configDir + "/plugins/obsidian-completr/" + path.join("/");
}

export interface LLMProviderSettings {
    enabled: boolean;
    endpoint: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    timeout?: number;
}

export function getLLMProviderSettings(settings: CompletrSettings): LLMProviderSettings {
    const endpoint = settings.llmApiUrl?.trim() ?? "";
    const model = settings.llmModel?.trim();
    const timeout = settings.llmRequestTimeout;
    const temperature = settings.llmTemperature;
    return {
        enabled: settings.llmProviderEnabled,
        endpoint,
        apiKey: settings.llmApiKey?.trim() ? settings.llmApiKey : undefined,
        model: model ? model : undefined,
        temperature: Number.isFinite(temperature) ? temperature : undefined,
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    };
}
