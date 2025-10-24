import { CompletrSettings, WordInsertionMode } from "../settings";
import { Suggestion, SuggestionContext, SuggestionProvider } from "./provider";
import { maybeLowerCase } from "../editor_helpers";

interface SuggestionCache {
    query: string;
    ignoreCase: boolean;
    ignoreDiacritics: boolean;
    firstChar: string;
    matches: string[];
}

export abstract class DictionaryProvider implements SuggestionProvider {

    abstract readonly wordMap: Map<string, Iterable<string>>;

    abstract isEnabled(settings: CompletrSettings): boolean;

    // Limit cache size by keeping only the most recent normalized query and its matches.
    private suggestionCache: SuggestionCache | null = null;

    getSuggestions(context: SuggestionContext, settings: CompletrSettings): Suggestion[] {
        if (!this.isEnabled(settings) || !context.query || context.query.length < settings.minWordTriggerLength)
            return [];

        const ignoreCase = settings.wordInsertionMode != WordInsertionMode.MATCH_CASE_REPLACE;

        let query = maybeLowerCase(context.query, ignoreCase);
        const ignoreDiacritics = settings.ignoreDiacriticsWhenFiltering;
        if (ignoreDiacritics)
            query = removeDiacritics(query);

        const firstChar = query.charAt(0);

        const cached = this.suggestionCache;
        const canReuseCache = cached &&
            cached.ignoreCase === ignoreCase &&
            cached.ignoreDiacritics === ignoreDiacritics &&
            cached.firstChar === firstChar &&
            query.startsWith(cached.query);

        if (!canReuseCache)
            this.suggestionCache = null;

        //This is an array of arrays to avoid unnecessarily creating a new huge array containing all elements of both arrays.
        const list = ignoreCase ?
            [(this.wordMap.get(firstChar) ?? []), (this.wordMap.get(firstChar.toUpperCase()) ?? [])] //Get both lists if we're ignoring case
            :
            [this.wordMap.get(firstChar) ?? []];

        if (ignoreDiacritics) {
            // This additionally adds all words that start with a diacritic, which the two maps above might not cover.
            for (let [key, value] of this.wordMap.entries()) {
                let keyFirstChar = maybeLowerCase(key.charAt(0), ignoreCase);

                if (removeDiacritics(keyFirstChar) === firstChar)
                    list.push(value);
            }
        }

        if (!list || list.length < 1)
            return [];

        const matches: string[] = [];

        if (canReuseCache) {
            matches.push(...filterIterable(cached!.matches, query, ignoreCase, ignoreDiacritics));
        } else {
            for (let el of list)
                matches.push(...filterIterable(el, query, ignoreCase, ignoreDiacritics));
        }

        this.suggestionCache = {
            query,
            ignoreCase,
            ignoreDiacritics,
            firstChar,
            matches
        };

        //TODO: Rank those who match case higher
        const mapSuggestion = settings.wordInsertionMode === WordInsertionMode.IGNORE_CASE_APPEND ?
            //In append mode we combine the query with the suggestions
            ((s: string) => Suggestion.fromString(context.query + s.substring(query.length, s.length))) :
            ((s: string) => Suggestion.fromString(s));

        const result = matches.map(mapSuggestion);

        // Cache keeps the last normalized query only, which prevents stale entries when the user
        // toggles case sensitivity or diacritic-aware filtering. The normalized `query` ensures that
        // case-insensitive and diacritic-stripped comparisons stay consistent between cache hits and misses.
        return result.sort((a, b) => a.displayName.length - b.displayName.length);
    }
}

const DIACRITICS_REGEX = /[\u0300-\u036f]/g

function removeDiacritics(str: string): string {
    return str.normalize("NFD").replace(DIACRITICS_REGEX, "");
}

function filterIterable(iterable: Iterable<string>, query: string, ignoreCase: boolean, ignoreDiacritics: boolean): string[] {
    const matches: string[] = [];
    for (let val of iterable) {
        let normalized = maybeLowerCase(val, ignoreCase);
        if (ignoreDiacritics)
            normalized = removeDiacritics(normalized);
        if (normalized.startsWith(query))
            matches.push(val);
    }
    return matches;
}
