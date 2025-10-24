import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { Suggestion, SuggestionContext, SuggestionProvider, SuggestionTriggerSource } from "./provider";
import { CompletrSettings, LLMProviderSettings, getLLMProviderSettings } from "../settings";

const CACHE_SEPARATOR = "\u241E"; // Record separator character to avoid clashes with real text.
const CHAT_COMPLETION_CONTEXT_LIMIT = 6000;
const DEFAULT_CHAT_MODEL = "gpt-3.5-turbo";
const CHAT_COMPLETION_PROMPT = "You are an autocomplete assistant for the Obsidian note-taking app. Complete what word the user is typing. Return ONLY a JSON array of 5 suggestion words with no commentary.";
const DEFAULT_CHAT_TEMPERATURE = 0.7;
const DEFAULT_TRIGGER_SOURCE: SuggestionTriggerSource = "unknown";

class LlmSuggestionProvider implements SuggestionProvider {

    private cacheKey: string | null = null;
    private cacheValue: Suggestion[] = [];
    private inflightKey: string | null = null;
    private inflightPromise: Promise<Suggestion[]> | null = null;

    async getSuggestions(context: SuggestionContext, settings: CompletrSettings): Promise<Suggestion[]> {
        const providerSettings = getLLMProviderSettings(settings);
        if (!this.isEnabled(providerSettings))
            return [];

        const priorText = context.editor.getRange({ line: 0, ch: 0 }, context.end);
        const triggerSource = context.triggerSource ?? DEFAULT_TRIGGER_SOURCE;
        const cacheKey = this.createCacheKey(priorText, context.separatorChar);

        this.logTrigger(triggerSource, context);

        if (this.cacheKey === cacheKey)
            return this.cacheValue;

        if (this.inflightPromise && this.inflightKey === cacheKey)
            return this.inflightPromise;

        const requestPromise = this.fetchSuggestions(providerSettings, priorText, context.separatorChar, context.query ?? "", triggerSource);
        this.inflightKey = cacheKey;
        this.inflightPromise = requestPromise;

        try {
            const suggestions = await requestPromise;
            if (this.inflightKey === cacheKey) {
                this.cacheKey = cacheKey;
                this.cacheValue = suggestions;
            }
            return suggestions;
        } finally {
            if (this.inflightKey === cacheKey) {
                this.inflightKey = null;
                this.inflightPromise = null;
            }
        }
    }

    private isEnabled(settings: LLMProviderSettings | undefined): settings is LLMProviderSettings {
        return !!settings && settings.enabled && !!settings.endpoint?.trim();
    }

    private createCacheKey(priorText: string, separator: string): string {
        return `${priorText}${CACHE_SEPARATOR}${separator ?? ""}`;
    }

    private async fetchSuggestions(
        settings: LLMProviderSettings,
        priorText: string,
        separator: string,
        query: string,
        triggerSource: SuggestionTriggerSource,
    ): Promise<Suggestion[]> {
        try {
            const body = this.buildChatCompletionBody(settings, priorText);

            this.logRequest(settings.endpoint, triggerSource, body, {
                separator,
                query,
            });

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

    private buildChatCompletionBody(settings: LLMProviderSettings, priorText: string): string {
        const clippedContext = this.clipContext(priorText, CHAT_COMPLETION_CONTEXT_LIMIT);
        const model = settings.model?.trim() || (this.isOpenAIEndpoint(settings.endpoint) ? DEFAULT_CHAT_MODEL : undefined);
        const temperature = this.resolveTemperature(settings.temperature);

        const payload: Record<string, unknown> = {
            temperature,
            messages: [
                { role: "system", content: CHAT_COMPLETION_PROMPT },
                { role: "user", content: clippedContext },
            ],
        };

        if (model)
            payload.model = model;

        return JSON.stringify(payload);
    }

    private clipContext(priorText: string, limit: number): string {
        if (priorText.length <= limit)
            return priorText;

        return priorText.slice(priorText.length - limit);
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
}

export const LLM = new LlmSuggestionProvider();
