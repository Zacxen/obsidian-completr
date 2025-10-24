import { Suggestion, SuggestionProvider, SuggestionTriggerSource } from "./provider/provider";
import { Latex } from "./provider/latex_provider";
import { WordList } from "./provider/word_list_provider";
import { FileScanner } from "./provider/scanner_provider";
import {
    App,
    Editor,
    EditorPosition,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    getIcon,
    TFile
} from "obsidian";
import SnippetManager from "./snippet_manager";
import { CompletrSettings } from "./settings";
import { FrontMatter } from "./provider/front_matter_provider";
import {matchWordBackwards} from "./editor_helpers";
import { SuggestionBlacklist } from "./provider/blacklist";
import { Callout } from "./provider/callout_provider";
import { LLM } from "./provider/llm_provider";

const PROVIDERS: SuggestionProvider[] = [FrontMatter, Callout, Latex, LLM, FileScanner, WordList];

function isPromiseLike<T>(value: PromiseLike<T> | T): value is PromiseLike<T> {
    return !!value && typeof (value as PromiseLike<T>).then === "function";
}

export default class SuggestionPopup extends EditorSuggest<Suggestion> {
    /**
     * Hacky variable to prevent the suggestion window from immediately re-opening after completing a suggestion
     */
    private justClosed: boolean;
    private separatorChar: string;
    private triggerSource: SuggestionTriggerSource = "unknown";

    private characterRegex: string;
    private compiledCharacterRegex: RegExp;
    private focused: boolean = false;

    private readonly snippetManager: SnippetManager;
    private readonly settings: CompletrSettings;
    private readonly disableSnippets: boolean;

    constructor(app: App, settings: CompletrSettings, snippetManager: SnippetManager) {
        super(app);
        this.disableSnippets = (app.vault as any).config?.legacyEditor;
        this.settings = settings;
        this.snippetManager = snippetManager;

        //Remove default key registrations
        let self = this as any;
        self.scope.keys = [];
    }

    open() {
        super.open();
        this.focused = this.settings.autoFocus;

        if (!this.focused) {
            for (const c of (this as any).suggestions.containerEl.children)
                c.removeClass("is-selected");
        }
    }

    close() {
        super.close();
        this.focused = false;
        this.triggerSource = "unknown";
    }

    async getSuggestions(
        context: EditorSuggestContext
    ): Promise<Suggestion[] | null> {
        const providerContext = {
            ...context,
            separatorChar: this.separatorChar,
            triggerSource: this.triggerSource,
        };

        const providerResults: (Suggestion[] | undefined)[] = new Array(PROVIDERS.length);
        const pendingAsync: Promise<void>[] = [];
        let blockingIndex: number | null = null;

        for (let i = 0; i < PROVIDERS.length; i++) {
            if (blockingIndex !== null && i > blockingIndex)
                break;

            const provider = PROVIDERS[i];
            const maybeSuggestions = provider.getSuggestions(providerContext, this.settings);

            if (isPromiseLike(maybeSuggestions)) {
                const task = Promise.resolve(maybeSuggestions)
                    .then((results) => results ?? [])
                    .catch((error) => {
                        console.warn("Completr: Failed to fetch suggestions", error);
                        return [] as Suggestion[];
                    })
                    .then((results) => {
                        providerResults[i] = results;

                        if (results.length > 0 && provider.blocksAllOtherProviders) {
                            blockingIndex = blockingIndex === null ? i : Math.min(blockingIndex, i);
                            results.forEach((suggestion) => {
                                if (!suggestion.overrideStart)
                                    return;

                                // Fixes popup position
                                this.context.start = suggestion.overrideStart;
                            });
                        }
                    });

                pendingAsync.push(task);
                continue;
            }

            const providerSuggestions = maybeSuggestions ?? [];
            providerResults[i] = providerSuggestions;

            if (providerSuggestions.length > 0 && provider.blocksAllOtherProviders) {
                providerSuggestions.forEach((suggestion) => {
                    if (!suggestion.overrideStart)
                        return;

                    // Fixes popup position
                    this.context.start = suggestion.overrideStart;
                });

                blockingIndex = i;
                break;
            }
        }

        if (pendingAsync.length > 0)
            await Promise.allSettled(pendingAsync);

        const seen = new Set<string>();
        const suggestions: Suggestion[] = [];
        const lastIndex = blockingIndex ?? (PROVIDERS.length - 1);

        for (let i = 0; i <= lastIndex && i < providerResults.length; i++) {
            const providerSuggestions = providerResults[i];
            if (!providerSuggestions || providerSuggestions.length === 0)
                continue;

            for (const suggestion of providerSuggestions) {
                if (seen.has(suggestion.displayName))
                    continue;

                if (SuggestionBlacklist.has(suggestion))
                    continue;

                seen.add(suggestion.displayName);
                suggestions.push(suggestion);
            }
        }

        return suggestions.length === 0 ? null : suggestions;
    }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
        return this.internalOnTrigger(editor, cursor, !file);
    }

    private internalOnTrigger(editor: Editor, cursor: EditorPosition, manualTrigger: boolean): EditorSuggestTriggerInfo | null {
        if (this.justClosed) {
            this.justClosed = false;
            return null;
        }

        if (!this.settings.autoTrigger && !manualTrigger) {
            this.close();
            return null;
        }

        let {
            query,
            separatorChar
        } = matchWordBackwards(editor, cursor, (char) => this.getCharacterRegex().test(char), this.settings.maxLookBackDistance);
        this.separatorChar = separatorChar;

        this.triggerSource = manualTrigger ? "manual" : "auto";

        return {
            start: {
                ...cursor,
                ch: cursor.ch - query.length,
            },
            end: cursor,
            query: query,
        };
    }

    renderSuggestion(value: Suggestion, el: HTMLElement): void {
        el.addClass("completr-suggestion-item");
        if (value.color != null) {
            el.style.setProperty("--completr-suggestion-color", value.color);
        }

        // Add the icon.
        if (value.icon != null) {
            const icon = getIcon(value.icon);
            if (icon != null) {
                icon.addClass("completr-suggestion-icon");
                el.appendChild(icon);
            }
        }

        // Add the text.
        const text = el.doc.createElement("div");
        text.addClass("completr-suggestion-text");
        text.setText(value.displayName);
        el.appendChild(text);
    }

    selectSuggestion(value: Suggestion, evt: MouseEvent | KeyboardEvent): void {
        const replacement = value.replacement;
        const start = typeof value !== "string" && value.overrideStart ? value.overrideStart : this.context.start;

        const endPos = value.overrideEnd ?? this.context.end;
        this.context.editor.replaceRange(replacement, start, {
            ...endPos,
            ch: Math.min(endPos.ch, this.context.editor.getLine(endPos.line).length)
        });

        //Check if suggestion is a snippet
        if (replacement.contains("#") || replacement.contains("~")) {
            if (!this.disableSnippets) {
                this.snippetManager.handleSnippet(replacement, start, this.context.editor);
            } else {
                console.log("Completr: Please enable Live Preview mode to use snippets");
            }
        } else {
            this.context.editor.setCursor({ ...start, ch: start.ch + replacement.length });
        }

        this.close();
        this.justClosed = true;
    }

    selectNextItem(dir: SelectionDirection) {
        if (!this.focused) {
            this.focused = true;
            dir = dir === SelectionDirection.PREVIOUS ? dir : SelectionDirection.NONE;
        }

        const self = this as any;
        // HACK: The second parameter has to be an instance of KeyboardEvent to force scrolling the selected item into
        // view
        self.suggestions.setSelectedItem(self.suggestions.selectedItem + dir, new KeyboardEvent("keydown"));
    }

    getSelectedItem(): Suggestion {
        const self = this as any;
        return self.suggestions.values[self.suggestions.selectedItem];
    }

    applySelectedItem() {
        const self = this as any;
        self.suggestions.useSelectedItem();
    }

    postApplySelectedItem(editor: Editor) {
        if (!this.settings.insertSpaceAfterComplete) {
            return
        }
        
        const cursor = editor.getCursor()
        editor.replaceRange(" ", cursor)
        editor.setCursor({line: cursor.line, ch: cursor.ch + 1})
    }

    isVisible(): boolean {
        return (this as any).isOpen;
    }

    isFocused(): boolean {
        return this.focused;
    }

    preventNextTrigger() {
        this.justClosed = true;
    }

    private getCharacterRegex(): RegExp {
        if (this.characterRegex !== this.settings.characterRegex)
            this.compiledCharacterRegex = new RegExp("[" + this.settings.characterRegex + "]", "u");

        return this.compiledCharacterRegex;
    }

}

export enum SelectionDirection {
    NEXT = 1,
    PREVIOUS = -1,
    NONE = 0,
}
