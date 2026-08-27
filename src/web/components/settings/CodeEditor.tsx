/**
 * A code editor, for the one place this application has code in it: the plugin
 * editor in Settings.
 *
 * ## Why CodeMirror 6, and what it was weighed against
 *
 * | | |
 * |---|---|
 * | **Monaco** (VS Code's editor) | The best editor, and the wrong one here. It is ~5 MB, it wants web workers and its own module loader, and its TypeScript intelligence means shipping a second copy of the compiler to the browser. This app's whole bundle is smaller than Monaco's language service. |
 * | **Ace** | Works, but it is a pre-ESM library with a global loader, and its React story is a wrapper nobody maintains. |
 * | **A `<textarea>` with Prism painted underneath** | ~10 kB and genuinely tempting. It loses bracket matching, indentation, undo grouping, and multi-line editing behaviour — and this is a text box where a missing brace produces a plugin that does not load. |
 * | **Shiki in a `contenteditable`** | Beautiful highlighting, a WASM payload, and the same editing problems as the textarea. |
 * | **CodeMirror 6** ✅ | ~250 kB, pure ESM with no workers, no build-tool plugin, bundles with `Bun.build` untouched. Real editing behaviour, TypeScript-aware highlighting through `@codemirror/lang-javascript`. |
 *
 * 🔴 The deciding line is the middle two rows. What is being typed here is a
 * file the server will `import`, and a syntax error is a plugin in the `error`
 * state. An editor that does not close brackets or keep indentation is one that
 * *causes* the failure mode this screen exists to display.
 *
 * ⚠️ It highlights TypeScript; it does not check it. There is no language
 * server and no `tsc` in the browser, so a type error looks exactly like
 * correct code here — the check that matters is the reload after saving, which
 * is real, and which is why the save response carries the plugin's state.
 *
 * ## The React part, which is where wrappers usually go wrong
 *
 * A CodeMirror view is an imperative object with its own state, and the
 * mistake is to treat `value` as a controlled prop: every keystroke would
 * re-render, re-dispatch the document, and move the cursor to the end. So:
 *
 * - the view is built **once per `docKey`** — the file being edited — and never
 *   rebuilt for a value it produced itself;
 * - `onChange` is read through a ref, so a new closure each render does not
 *   tear the editor down;
 * - the theme lives in a `Compartment` and is reconfigured in place, because
 *   switching to dark mode must not throw away what someone has typed.
 */
import { useEffect, useRef } from "react";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";

export interface CodeEditorProps {
  /** The initial document for this `docKey`. Not a controlled value — see the header. */
  value: string;
  onChange: (next: string) => void;
  /**
   * Changing this rebuilds the editor with `value` as its document.
   *
   * The filename, in practice: opening a different plugin has to replace the
   * document, and nothing else should.
   */
  docKey: string;
  dark: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  /** Tailwind height for the scroller. The dialog decides how tall the editor is. */
  className?: string;
}

/** Constant identity: a new `Compartment` per render would reconfigure nothing. */
const themeCompartment = new Compartment();

/**
 * Sizing lives here rather than in a stylesheet because CodeMirror renders into
 * its own DOM, outside anything Tailwind's class scanner sees.
 */
const layout = EditorView.theme({
  "&": { height: "100%", fontSize: "12px" },
  ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  "&.cm-focused": { outline: "none" },
});

export function CodeEditor({ value, onChange, docKey, dark, readOnly, ariaLabel, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /** The latest callback, so a re-render never rebuilds the editor. */
  const notify = useRef(onChange);
  /** The text to open with. Read once, when the view for this `docKey` is built. */
  const initial = useRef(value);

  /**
   * ⚠️ Assigned in an effect, not during render.
   *
   * Writing `ref.current` while rendering is a real hazard rather than a style
   * rule: React may render a component and throw the result away, and a ref
   * written during that render keeps the value from a render nobody kept. This
   * effect has **no dependency array on purpose** — it must run after every
   * render — and it is declared **before** the one below, because effects run in
   * declaration order and the view is built from `initial.current`.
   */
  useEffect(() => {
    notify.current = onChange;
    initial.current = value;
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          basicSetup,
          // `typescript: true` is what makes `interface`, type annotations and
          // `satisfies` highlight instead of reading as syntax errors.
          javascript({ typescript: true }),
          // ⚠️ After `basicSetup`, whose keymap would otherwise win: without
          // this, Tab moves focus out of the editor, which in a dialog means
          // Tab jumps to the Save button mid-line.
          keymap.of([indentWithTab]),
          layout,
          // The label goes on CodeMirror's own `contenteditable`, which already
          // carries `role="textbox"`. Putting a second textbox role on the
          // wrapper would announce two.
          EditorView.contentAttributes.of({ "aria-label": ariaLabel ?? "Plugin source" }),
          themeCompartment.of(dark ? oneDark : []),
          EditorState.readOnly.of(readOnly === true),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) notify.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;

    return () => {
      editor.destroy();
      view.current = null;
    };
    // `dark` is deliberately absent: it is reconfigured below rather than
    // rebuilding the editor, which would discard unsaved edits on a theme change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, readOnly, ariaLabel]);

  useEffect(() => {
    view.current?.dispatch({ effects: themeCompartment.reconfigure(dark ? oneDark : []) });
  }, [dark]);

  return <div ref={host} className={className} />;
}
