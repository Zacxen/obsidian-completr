import { requestUrl } from "obsidian";
import type { Editor, EditorPosition, RequestUrlResponse } from "obsidian";
import { Suggestion, SuggestionContext, SuggestionProvider, SuggestionTriggerSource } from "./provider";
import { CompletrSettings, LLMProviderSettings, getLLMProviderSettings } from "../settings";
import { editorToCodeMirrorState, indexFromPos, posFromIndex } from "../editor_helpers";

const CACHE_SEPARATOR = "\u241E"; // Record separator character to avoid clashes with real text.
const CHAT_COMPLETION_CONTEXT_LIMIT = 6000;
const DEFAULT_CHAT_MODEL = "gpt-3.5-turbo";
const CHAT_COMPLETION_PROMPT = "You are an autocomplete assistant for the Obsidian note-taking app. Complete what word the user is typing. Return ONLY a JSON array of 5 WORDS with no commentary. If the last word a user has is a partial word, suggest what words the user is trying to type.";
const DEFAULT_CHAT_TEMPERATURE = 0.7;
const DEFAULT_TRIGGER_SOURCE: SuggestionTriggerSource = "unknown";

type PreparedRequestSource = "generated" | "cache";

type PreparedRequest = {
    body: string;
    clippedContext: string;
    model: string | undefined;
    temperature: number;
    source: PreparedRequestSource;
};

type CachedSuggestions = {
    suggestions: Suggestion[];
    request: PreparedRequest;
};

type PendingRequest = {
    settings: LLMProviderSettings;
    request: PreparedRequest;
    separator: string;
    query: string;
    triggerSource: SuggestionTriggerSource;
};

class LlmSuggestionProvider implements SuggestionProvider {

    private cacheKey: string | null = null;
    private cacheValue: CachedSuggestions | null = null;
    private inflightKey: string | null = null;
    private inflightPromise: Promise<Suggestion[]> | null = null;
    private pendingKey: string | null = null;
    private pendingArgs: PendingRequest | null = null;
    private requestCache = new Map<string, PreparedRequest>();

    async getSuggestions(context: SuggestionContext, settings: CompletrSettings): Promise<Suggestion[]> {
        const providerSettings = getLLMProviderSettings(settings);
        if (!this.isEnabled(providerSettings))
            return [];

        const limitedContext = this.readLimitedContext(context.editor, context.end, CHAT_COMPLETION_CONTEXT_LIMIT);
        const clippedContext = this.clipContext(limitedContext, CHAT_COMPLETION_CONTEXT_LIMIT);
        const temperature = this.resolveTemperature(providerSettings.temperature);
        const model = this.resolveModel(providerSettings);
        const triggerSource = context.triggerSource ?? DEFAULT_TRIGGER_SOURCE;
        const cacheKey = this.createCacheKey(clippedContext, context.separatorChar, model, temperature);
        const cachedSuggestions = this.cacheKey === cacheKey ? this.cacheValue : null;

        this.logTrigger(triggerSource, context);

        if (cachedSuggestions)
            return cachedSuggestions.suggestions;

        const cachedRequest = this.requestCache.get(cacheKey);
        const request = cachedRequest ? this.clonePreparedRequest(cachedRequest, "cache") : this.prepareChatCompletionRequest(
            clippedContext,
            model,
            temperature,
        );

        if (this.inflightPromise) {
            if (this.inflightKey === cacheKey)
                return this.inflightPromise;

            this.pendingKey = cacheKey;
            this.pendingArgs = {
                settings: providerSettings,
                request,
                separator: context.separatorChar,
                query: context.query ?? "",
                triggerSource,
            };

            return [];
        }

        return this.executeRequest(cacheKey, {
            settings: providerSettings,
            request,
            separator: context.separatorChar,
            query: context.query ?? "",
            triggerSource,
        });
    }

    private isEnabled(settings: LLMProviderSettings | undefined): settings is LLMProviderSettings {
        return !!settings && settings.enabled && !!settings.endpoint?.trim();
    }

    private createCacheKey(clippedContext: string, separator: string, model: string | undefined, temperature: number): string {
        const components = [
            clippedContext,
            separator ?? "",
            model ?? "",
            temperature.toFixed(3),
        ];

        return components.join(CACHE_SEPARATOR);
    }

    private async fetchSuggestions(
        settings: LLMProviderSettings,
        request: PreparedRequest,
        separator: string,
        query: string,
        triggerSource: SuggestionTriggerSource,
    ): Promise<Suggestion[]> {
        try {
            const body = request.body;

            this.logRequest(settings.endpoint, triggerSource, body, {
                separator,
                query,
            }, request.source);

            const response = await requestUrl({
                url: settings.endpoint,
                method: "POST",
                body,
                headers: {
                    "Content-Type": "application/json",
                    ...(settings.apiKey ? { "Authorization": `Bearer ${settings.apiKey}` } : {}),
                },
                timeout: settings.timeout,
                throw: false,
            });

            const payload = await this.resolvePayload(response);

            this.logResponse(settings.endpoint, triggerSource, response.status, payload);

            if (response.status < 200 || response.status >= 300)
                return [];

            let words = this.extractWords(payload);

            if (!words.length)
                words = this.extractOpenAIWords(payload);

            return words.map((word) => Suggestion.fromString(word));
        } catch (error) {
            console.warn("Completr: Failed to fetch LLM suggestions", {
                triggerSource,
                error,
            });
            return [];
        }
    }

    private prepareChatCompletionRequest(
        clippedContext: string,
        model: string | undefined,
        temperature: number,
    ): PreparedRequest {
        const payload: Record<string, unknown> = {
            temperature,
            messages: [
                { role: "system", content: CHAT_COMPLETION_PROMPT },
                { role: "user", content: clippedContext },
            ],
        };

        if (model)
            payload.model = model;

        return {
            body: JSON.stringify(payload),
            clippedContext,
            model,
            temperature,
            source: "generated",
        };
    }

    private clonePreparedRequest(request: PreparedRequest, source: PreparedRequestSource = request.source): PreparedRequest {
        return {
            body: request.body,
            clippedContext: request.clippedContext,
            model: request.model,
            temperature: request.temperature,
            source,
        };
    }

    private storePreparedRequest(key: string, request: PreparedRequest): void {
        this.requestCache.set(key, this.clonePreparedRequest(request, "generated"));

        while (this.requestCache.size > 20) {
            const iterator = this.requestCache.keys().next();
            if (iterator.done)
                break;

            this.requestCache.delete(iterator.value);
        }
    }

    private readLimitedContext(editor: Editor, end: EditorPosition, limit: number): string {
        const state = editorToCodeMirrorState(editor);
        const doc = state.doc;
        const endIndex = indexFromPos(doc, end);
        const startIndex = Math.max(0, endIndex - limit);
        const start = posFromIndex(doc, startIndex);

        return editor.getRange(start, end);
    }

    private clipContext(priorText: string, limit: number): string {
        if (priorText.length <= limit)
            return priorText;

        return priorText.slice(priorText.length - limit);
    }

    private resolveModel(settings: LLMProviderSettings): string | undefined {
        const configuredModel = settings.model?.trim();
        if (configuredModel)
            return configuredModel;

        return this.isOpenAIEndpoint(settings.endpoint) ? DEFAULT_CHAT_MODEL : undefined;
    }

    private resolveTemperature(value: number | undefined): number {
        if (typeof value !== "number" || Number.isNaN(value))
            return DEFAULT_CHAT_TEMPERATURE;

        const clamped = Math.max(0, Math.min(2, value));
        return clamped;
    }

    private isOpenAIEndpoint(endpoint: string | undefined): boolean {
        if (!endpoint)
            return false;

        const normalised = endpoint.toLowerCase();
        if (normalised.includes("api.openai.com"))
            return true;

        return /\/v\d+\/chat\/completions\b/.test(normalised);
    }

    private safeParseJson(text: string | undefined): unknown {
        if (!text)
            return null;

        try {
            return JSON.parse(text);
        } catch (error) {
            console.warn("Completr: Unable to parse LLM response", error);
            return null;
        }
    }

    private extractWords(payload: unknown): string[] {
        if (Array.isArray(payload))
            return payload.filter((entry): entry is string => typeof entry === "string");

        if (payload && typeof payload === "object") {
            const { suggestions, words, completions, data } = payload as Record<string, unknown>;

            if (Array.isArray(suggestions))
                return suggestions.filter((entry): entry is string => typeof entry === "string");

            if (Array.isArray(words))
                return words.filter((entry): entry is string => typeof entry === "string");

            if (Array.isArray(completions))
                return completions.filter((entry): entry is string => typeof entry === "string");

            if (Array.isArray(data))
                return data.filter((entry): entry is string => typeof entry === "string");
        }

        return [];
    }

    private extractOpenAIWords(payload: unknown): string[] {
        if (!payload || typeof payload !== "object")
            return [];

        const choices = (payload as Record<string, unknown>).choices;
        if (!Array.isArray(choices))
            return [];

        const words: string[] = [];

        for (const choice of choices) {
            if (!choice || typeof choice !== "object")
                continue;

            const choiceRecord = choice as Record<string, unknown>;
            const message = choiceRecord.message;
            if (message && typeof message === "object") {
                const content = (message as Record<string, unknown>).content;
                if (typeof content === "string") {
                    words.push(...this.parseOpenAIContent(content));
                    continue;
                }
            }

            const text = choiceRecord.text;
            if (typeof text === "string")
                words.push(...this.parseOpenAIContent(text));
        }

        return words;
    }

    private parseOpenAIContent(raw: string): string[] {
        const trimmed = raw.trim();
        if (!trimmed)
            return [];

        const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const content = codeBlockMatch ? codeBlockMatch[1].trim() : trimmed;

        const parsed = this.tryParseJson(content);
        if (Array.isArray(parsed))
            return parsed.filter((entry): entry is string => typeof entry === "string");

        return content
            .split(/\r?\n+/)
            .map((line) => line.replace(/^[\-\d\.]*(?:\)|\.|:)?\s*/, "").trim())
            .filter((line) => line.length > 0);
    }

    private tryParseJson(text: string): unknown {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    private async resolvePayload(response: RequestUrlResponse): Promise<unknown> {
        const resolvedJson = await this.resolvePossiblePromise(response.json);
        if (resolvedJson !== undefined && resolvedJson !== null) {
            if (typeof resolvedJson === "string") {
                const parsed = this.safeParseJson(resolvedJson);
                if (parsed !== null)
                    return parsed;
            } else {
                return resolvedJson;
            }
        }

        const resolvedText = await this.resolvePossiblePromise(response.text);
        if (typeof resolvedText === "string")
            return this.safeParseJson(resolvedText);

        return null;
    }

    private async resolvePossiblePromise<T>(value: T | Promise<T>): Promise<T>;
    private async resolvePossiblePromise<T>(value: T | Promise<T> | undefined | null): Promise<T | undefined | null>;
    private async resolvePossiblePromise<T>(value: T | Promise<T> | undefined | null): Promise<T | undefined | null> {
        if (this.isPromise(value)) {
            try {
                return await value;
            } catch (error) {
                console.warn("Completr: Failed to resolve LLM response", error);
                return undefined;
            }
        }

        return value;
    }

    private isPromise<T>(value: T | Promise<T> | undefined | null): value is Promise<T> {
        return !!value && typeof value === "object" && typeof (value as Promise<T>).then === "function";
    }

    private logTrigger(triggerSource: SuggestionTriggerSource, context: SuggestionContext): void {
        console.debug("Completr LLM: Triggered provider", {
            triggerSource,
            query: context.query,
            separator: context.separatorChar,
            cursor: context.end,
        });
    }

    private logRequest(
        endpoint: string | undefined,
        triggerSource: SuggestionTriggerSource,
        body: string,
        context: { separator: string; query: string },
        requestSource: PreparedRequestSource,
    ): void {
        let parsedBody: unknown = body;
        try {
            parsedBody = JSON.parse(body);
        } catch {
            parsedBody = body;
        }

        console.debug("Completr LLM: Outgoing request", {
            triggerSource,
            endpoint,
            separator: context.separator,
            query: context.query,
            requestSource,
            body: parsedBody,
        });
    }

    private logResponse(
        endpoint: string | undefined,
        triggerSource: SuggestionTriggerSource,
        status: number,
        payload: unknown,
    ): void {
        console.debug("Completr LLM: Incoming response", {
            triggerSource,
            endpoint,
            status,
            payload,
        });
    }

    private async executeRequest(key: string, args: PendingRequest): Promise<Suggestion[]> {
        const requestPromise = this.fetchSuggestions(
            args.settings,
            args.request,
            args.separator,
            args.query,
            args.triggerSource,
        );

        this.inflightKey = key;
        this.inflightPromise = requestPromise;

        try {
            const suggestions = await requestPromise;
            if (this.inflightKey === key) {
                this.cacheKey = key;
                const cachedRequest = this.clonePreparedRequest(args.request);
                this.cacheValue = {
                    suggestions,
                    request: cachedRequest,
                };
                this.storePreparedRequest(key, cachedRequest);
            }
            return suggestions;
        } finally {
            if (this.inflightKey === key) {
                this.inflightKey = null;
                this.inflightPromise = null;
                this.processPending();
            }
        }
    }

    private processPending(): void {
        if (this.inflightPromise || !this.pendingKey || !this.pendingArgs)
            return;

        const nextKey = this.pendingKey;
        const nextArgs = this.pendingArgs;

        this.pendingKey = null;
        this.pendingArgs = null;

        this.executeRequest(nextKey, nextArgs).catch((error) => {
            console.warn("Completr: Failed to fetch pending LLM suggestions", error);
        });
    }
}

export const LLM = new LlmSuggestionProvider();
