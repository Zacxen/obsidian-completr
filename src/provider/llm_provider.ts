import { requestUrl } from "obsidian";
import { Suggestion, SuggestionContext, SuggestionProvider } from "./provider";
import { CompletrSettings, LLMProviderSettings } from "../settings";

const CACHE_SEPARATOR = "\u241E"; // Record separator character to avoid clashes with real text.

class LlmSuggestionProvider implements SuggestionProvider {

    private cacheKey: string | null = null;
    private cacheValue: Suggestion[] = [];
    private inflightKey: string | null = null;
    private inflightPromise: Promise<Suggestion[]> | null = null;

    async getSuggestions(context: SuggestionContext, settings: CompletrSettings): Promise<Suggestion[]> {
        const providerSettings = settings.llmProvider;
        if (!this.isEnabled(providerSettings))
            return [];

        const priorText = context.editor.getRange({ line: 0, ch: 0 }, context.end);
        const cacheKey = this.createCacheKey(priorText, context.separatorChar);

        if (this.cacheKey === cacheKey)
            return this.cacheValue;

        if (this.inflightPromise && this.inflightKey === cacheKey)
            return this.inflightPromise;

        const requestPromise = this.fetchSuggestions(providerSettings, priorText, context.separatorChar, context.query ?? "");
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
        return !!settings && settings.enabled && !!settings.endpoint;
    }

    private createCacheKey(priorText: string, separator: string): string {
        return `${priorText}${CACHE_SEPARATOR}${separator ?? ""}`;
    }

    private async fetchSuggestions(settings: LLMProviderSettings, priorText: string, separator: string, query: string): Promise<Suggestion[]> {
        try {
            const body = JSON.stringify({
                text: priorText,
                separator,
                query,
                model: settings.model,
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

            if (response.status < 200 || response.status >= 300)
                return [];

            const payload = response.json ?? this.safeParseJson(response.text);
            const words = this.extractWords(payload);
            return words.map((word) => Suggestion.fromString(word));
        } catch (error) {
            console.warn("Completr: Failed to fetch LLM suggestions", error);
            return [];
        }
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
}

export const LLM = new LlmSuggestionProvider();
