import { requestUrl } from "obsidian";
import { Suggestion, SuggestionContext, SuggestionProvider } from "./provider";
import { CompletrSettings, LLMProviderSettings, getLLMProviderSettings } from "../settings";

const CACHE_SEPARATOR = "\u241E"; // Record separator character to avoid clashes with real text.
const OPENAI_CONTEXT_LIMIT = 6000;
const DEFAULT_OPENAI_MODEL = "gpt-3.5-turbo";
const OPENAI_JSON_PROMPT = "You are an autocomplete assistant for the Obsidian note-taking app. Return ONLY a JSON array of suggestion strings with no commentary.";

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
        return !!settings && settings.enabled && !!settings.endpoint?.trim();
    }

    private createCacheKey(priorText: string, separator: string): string {
        return `${priorText}${CACHE_SEPARATOR}${separator ?? ""}`;
    }

    private async fetchSuggestions(settings: LLMProviderSettings, priorText: string, separator: string, query: string): Promise<Suggestion[]> {
        try {
            const isOpenAI = this.isOpenAIEndpoint(settings.endpoint);
            const body = isOpenAI
                ? this.buildOpenAIBody(settings, priorText, separator, query)
                : JSON.stringify({
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
            let words = this.extractWords(payload);

            if (!words.length)
                words = this.extractOpenAIWords(payload);

            return words.map((word) => Suggestion.fromString(word));
        } catch (error) {
            console.warn("Completr: Failed to fetch LLM suggestions", error);
            return [];
        }
    }

    private buildOpenAIBody(settings: LLMProviderSettings, priorText: string, separator: string, query: string): string {
        const clippedContext = this.clipContext(priorText, OPENAI_CONTEXT_LIMIT);
        const model = settings.model?.trim() || DEFAULT_OPENAI_MODEL;

        const userContent = [
            "Context before cursor:",
            clippedContext || "<empty>",
            "",
            `Separator character: ${separator ?? ""}`,
            `Current query: ${query ?? ""}`,
            "",
            "Return up to 5 likely continuations as a JSON array of strings only.",
        ].join("\n");

        return JSON.stringify({
            model,
            messages: [
                { role: "system", content: OPENAI_JSON_PROMPT },
                { role: "user", content: userContent },
            ],
            temperature: 0.2,
            n: 1,
            max_tokens: 64,
        });
    }

    private clipContext(priorText: string, limit: number): string {
        if (priorText.length <= limit)
            return priorText;

        return priorText.slice(priorText.length - limit);
    }

    private isOpenAIEndpoint(endpoint: string | undefined): boolean {
        if (!endpoint)
            return false;

        const normalised = endpoint.toLowerCase();
        return normalised.includes("api.openai.com");
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
}

export const LLM = new LlmSuggestionProvider();
