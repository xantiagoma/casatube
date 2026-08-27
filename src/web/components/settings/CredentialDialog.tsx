/**
 * Adding a credential: the one place in this application where a secret is
 * typed, and the only direction it ever travels.
 *
 * ## What this form refuses to do
 *
 * 🔴 **It never prefills.** There is no "edit" here and no field showing dots
 * for a stored value, because the API has no way to send one back — every read
 * route selects around the `secret` column. A masked field would be a drawing
 * of a secret that is not there, and the moment somebody trusts it (types
 * nothing, presses save) it is a lie with consequences. Replacing a credential
 * is pasting it again, and the dialog says so.
 *
 * 🔴 **It does not re-validate what the server validates.** The combination of
 * type and fields, the shape of a `cookies.txt`, the scope — all of that is
 * decided on the server, and its 422 **names the field**. That message is
 * rendered verbatim: "the cookie file is empty", "line 3 is separated by
 * spaces, not tabs" is the whole value of the answer, and collapsing it into
 * "Invalid credential" throws away the only part anyone can act on.
 *
 * What the form *does* check is the small set of things Elysia's own schema
 * would reject before our handler ever runs — an empty `scope` — because those
 * come back as a bare 422 with no tagged body and therefore no sentence worth
 * showing. Everything else is sent and answered by the server.
 *
 * ⚠️ **The cookie notice sits next to the cookie box**, not in a footnote:
 * cookies expire in hours and replaying them from another IP is itself a signal
 * (PLAN §15). It is the server's own sentence, carried on the listing.
 */
import { useState } from "react";
import {
  CheckCircle2,
  FileUp,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  Plus,
  Save,
  TriangleAlert,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { CredentialType } from "../../../core/credentials";
import type { CreateCredentialBody, CredentialCreated, EncryptionState } from "../../data/credentials";
import { useCreateCredential } from "../../data/credentials";
import {
  CREDENTIAL_TYPE_ORDER,
  TYPE_HINT,
  TYPE_LABEL,
  countCookieLines,
  domainsLookRight,
  formatDomains,
  looksSpaceSeparated,
  previewScope,
  summaryFacts,
} from "./credential-view";

export interface CredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server's cookie sentence, from the listing. Never re-worded here. */
  notice: string;
  encryption: EncryptionState;
}

/** One key/value line of a `custom` credential, as the form holds it. */
interface Field {
  key: string;
  value: string;
}

/**
 * Everything typed, in **one** state object.
 *
 * Eight `useState` calls for eight fields of one form is eight things to
 * remember to clear when the form is reused — and forgetting one leaves a
 * password sitting in a hidden field of the next credential. One object clears
 * in one line, which is why the reset below can be trusted.
 */
interface FormState {
  type: CredentialType;
  scope: string;
  label: string;
  cookies: string;
  username: string;
  password: string;
  apiKey: string;
  fields: Field[];
}

const BLANK: FormState = {
  type: "cookies",
  scope: "",
  label: "",
  cookies: "",
  username: "",
  password: "",
  apiKey: "",
  fields: [{ key: "", value: "" }],
};

type Patch = (next: Partial<FormState>) => void;

export function CredentialDialog({ open, onOpenChange, notice, encryption }: CredentialDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ⚠️ `sm:max-w-2xl`, not `max-w-2xl`: DialogContent hard-codes
          `sm:max-w-lg`, and an unprefixed class loses to it above the `sm`
          breakpoint — i.e. everywhere but a phone (docs/DISCOVERIES.md). */}
      <DialogContent className="sm:max-w-2xl">
        {/* Radix unmounts the content on close, so every field, and the paste in
            them, dies with it. That is the disposal policy for a secret typed
            into a browser: nothing survives the dialog. */}
        <CredentialDialogBody notice={notice} encryption={encryption} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function CredentialDialogBody({ notice, encryption, onOpenChange }: Omit<CredentialDialogProps, "open">) {
  const save = useCreateCredential();
  const [form, setForm] = useState<FormState>(BLANK);
  const patch: Patch = (next) => setForm((current) => ({ ...current, ...next }));

  const saved = save.data ?? null;

  /**
   * The saved panel, and why it is worth the code.
   *
   * The interesting half of a successful save is what the **server** derived
   * from the jar: which domains it actually covers, how many cookies, when the
   * first one dies. A dialog that closes on success hides exactly the answer
   * that tells you whether you exported the right tab.
   */
  if (saved) {
    return (
      <SavedPanel
        created={saved}
        notice={notice}
        onAnother={() => {
          save.reset();
          // The site and the type are kept — another credential for the same
          // site is the common case — and every field that could still hold a
          // secret is dropped.
          setForm({ ...BLANK, type: form.type, scope: form.scope });
        }}
        onDone={() => onOpenChange(false)}
      />
    );
  }

  function submit() {
    const body: CreateCredentialBody = {
      scope: form.scope.trim(),
      type: form.type,
      ...(form.label.trim() === "" ? {} : { label: form.label.trim() }),
    };
    // 🔴 The field for the chosen type is always sent, even empty. Omitting it
    // gets "a cookies credential needs a cookies.txt in the cookies field";
    // sending an empty one gets "the cookie file is empty" — and the second is
    // the sentence that describes what actually happened.
    if (form.type === "cookies") body.cookies = form.cookies;
    if (form.type === "password") {
      body.username = form.username;
      body.password = form.password;
    }
    if (form.type === "apiKey") body.apiKey = form.apiKey;
    if (form.type === "custom") {
      const named = form.fields.filter((field) => field.key.trim() !== "");
      body.data = Object.fromEntries(named.map((field) => [field.key.trim(), field.value]));
    }
    save.mutate(body);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden />
          Add a credential
        </DialogTitle>
        <DialogDescription>
          One site, one type, one secret. Saving <strong>replaces</strong> any credential already stored for the
          same site and type — which is the normal case, because cookies expire and get pasted again.
        </DialogDescription>
      </DialogHeader>

      <div className="scrollbar-thin max-h-[62vh] space-y-4 overflow-y-auto pr-1">
        <TypePicker
          type={form.type}
          onPick={(type) => {
            patch({ type });
            // A failure belongs to the type that produced it; leaving "the
            // cookie file is empty" over a password form would be nonsense.
            save.reset();
          }}
        />

        <ScopeFields form={form} onPatch={patch} />

        {form.type === "cookies" ? <CookieFields form={form} onPatch={patch} notice={notice} /> : null}
        {form.type === "password" ? <PasswordFields form={form} onPatch={patch} /> : null}
        {form.type === "apiKey" ? <ApiKeyField form={form} onPatch={patch} /> : null}
        {form.type === "custom" ? <CustomFields form={form} onPatch={patch} /> : null}

        <EncryptionPanel encryption={encryption} />
      </div>

      {save.isError ? (
        // The server's own words. A 422 from this route names the field that is
        // wrong and says why; that is the answer, not a detail behind one.
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          {save.error.message}
        </p>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button className="gap-1.5" disabled={save.isPending || form.scope.trim() === ""} onClick={submit}>
          {save.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Save className="size-4" aria-hidden />
          )}
          Save credential
        </Button>
      </DialogFooter>
    </>
  );
}

function TypePicker({ type, onPick }: { type: CredentialType; onPick: (type: CredentialType) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>Type</Label>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {CREDENTIAL_TYPE_ORDER.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onPick(option)}
            className={cn(
              "rounded-lg border px-2 py-2 text-xs font-medium transition-colors",
              type === option ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent",
            )}
          >
            {TYPE_LABEL[option]}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{TYPE_HINT[type]}</p>
    </div>
  );
}

/** The two fields every type has: which site it is for, and what to call it. */
function ScopeFields({ form, onPatch }: { form: FormState; onPatch: Patch }) {
  const preview = previewScope(form.scope);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="credential-scope">Site</Label>
        <Input
          id="credential-scope"
          value={form.scope}
          onChange={(event) => onPatch({ scope: event.target.value })}
          placeholder="youtube.com"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          A host (<code>youtube.com</code>), a wildcard (<code>*.odysee.com</code>) or <code>*</code> for anything
          else. A whole URL, a leading dot and a port are all accepted and tidied up
          {preview !== "" && preview !== form.scope.trim() ? (
            <>
              {" "}
              — this will be stored as <code className="font-mono">{preview}</code>
            </>
          ) : null}
          .
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="credential-label">Label (optional)</Label>
        <Input
          id="credential-label"
          value={form.label}
          onChange={(event) => onPatch({ label: event.target.value })}
          placeholder="personal account"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Free text, for telling two accounts on the same site apart.
        </p>
      </div>
    </div>
  );
}

/**
 * The jar: the notice, the box, the upload, and the two mistakes worth catching
 * before the request is made.
 *
 * ⚠️ The space-separated and wrong-site lines are *hints*, not gates. The
 * server's parser is the authority and refuses the same paste for the same
 * reason; saying it here only means it is said a second earlier.
 */
function CookieFields({ form, onPatch, notice }: { form: FormState; onPatch: Patch; notice: string }) {
  const [readError, setReadError] = useState<string | null>(null);
  const preview = previewScope(form.scope);
  const cookieLines = countCookieLines(form.cookies);
  const spaceSeparated = form.cookies.trim() !== "" && looksSpaceSeparated(form.cookies);
  const jarDomains = domainsOf(form.cookies);
  const wrongSite = preview !== "" && jarDomains.length > 0 && !domainsLookRight(jarDomains, preview);

  return (
    <div className="space-y-2">
      {/* ⚠️ PLAN §15, beside the box rather than behind a "learn more". */}
      <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>{notice}</span>
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="credential-cookies">cookies.txt (Netscape format)</Label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-primary">
          <FileUp className="size-3.5" aria-hidden />
          Upload a file
          <input
            type="file"
            accept=".txt,text/plain"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // The value is cleared so choosing the same file twice fires
              // again — otherwise a re-export with the same name silently does
              // nothing.
              event.target.value = "";
              if (!file) return;
              setReadError(null);
              void file
                .text()
                .then((text) => onPatch({ cookies: text }))
                .catch(() => setReadError("That file could not be read in this browser."));
            }}
          />
        </label>
      </div>

      <Textarea
        id="credential-cookies"
        value={form.cookies}
        onChange={(event) => onPatch({ cookies: event.target.value })}
        placeholder={"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSID\t…"}
        spellCheck={false}
        className="scrollbar-thin h-48 max-h-64 resize-y font-mono text-[11px]"
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {cookieLines} cookie line{cookieLines === 1 ? "" : "s"}
        </span>
        {jarDomains.length > 0 ? <span>{formatDomains(jarDomains, 4)}</span> : null}
      </div>

      {readError ? <p className="text-xs text-destructive">{readError}</p> : null}

      {spaceSeparated ? (
        <p className="text-xs text-destructive">
          The fields in this paste are separated by <strong>spaces, not tabs</strong>. yt-dlp reads that as one
          field per line and behaves as if signed out — export the file again and upload it rather than copying it
          through a terminal or a chat window. The server will refuse it too.
        </p>
      ) : null}

      {wrongSite ? (
        <p className="text-xs text-warning">
          This jar carries cookies for {formatDomains(jarDomains, 3)}, which does not cover{" "}
          <code>{preview}</code>. That is usually the wrong browser tab. It will still be stored — the test button
          reports the server's own view.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Export it with a browser extension that writes the Netscape format — the seven fields are tab-separated,
        and lines beginning <code>#HttpOnly_</code> are cookies, not comments. It is checked here, at the paste,
        rather than twenty minutes into a download.
      </p>
    </div>
  );
}

function PasswordFields({ form, onPatch }: { form: FormState; onPatch: Patch }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="credential-username">Username</Label>
          <Input
            id="credential-username"
            value={form.username}
            onChange={(event) => onPatch({ username: event.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="credential-password">Password</Label>
          <Input
            id="credential-password"
            type="password"
            value={form.password}
            onChange={(event) => onPatch({ password: event.target.value })}
            autoComplete="new-password"
          />
        </div>
      </div>
      <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          yt-dlp takes the password as a <strong>command-line argument</strong>, so while a download runs it is
          visible to anything on this host that can read the process list. There is no file-based alternative
          short of <code>.netrc</code>. Reported rather than hidden.
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        The username is kept as metadata so two accounts on one site can be told apart. The password is not
        readable through the API by anything, including this screen.
      </p>
    </div>
  );
}

function ApiKeyField({ form, onPatch }: { form: FormState; onPatch: Patch }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="credential-apikey">API key</Label>
      <Input
        id="credential-apikey"
        type="password"
        value={form.apiKey}
        onChange={(event) => onPatch({ apiKey: event.target.value })}
        autoComplete="new-password"
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground">
        Stored, sealed and resolved for this site — and <strong>no built-in downloader reads it</strong>. yt-dlp
        has nowhere to put an API key, so this is for a plugin provider that asks for one. The test button says
        the same thing.
      </p>
    </div>
  );
}

function CustomFields({ form, onPatch }: { form: FormState; onPatch: Patch }) {
  const fields = form.fields;

  return (
    <div className="space-y-2">
      <Label>Fields</Label>
      {fields.map((field, index) => (
        // Positional keys: these rows have no identity of their own, and a key
        // from the typed name would remount the input on every keystroke —
        // which loses the caret.
        <div key={index} className="flex items-center gap-2">
          <Input
            value={field.key}
            placeholder="name"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              onPatch({
                fields: fields.map((row, at) => (at === index ? { ...row, key: event.target.value } : row)),
              })
            }
          />
          <Input
            value={field.value}
            type="password"
            placeholder="value"
            autoComplete="new-password"
            onChange={(event) =>
              onPatch({
                fields: fields.map((row, at) => (at === index ? { ...row, value: event.target.value } : row)),
              })
            }
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove field ${index + 1}`}
            disabled={fields.length === 1}
            onClick={() => onPatch({ fields: fields.filter((_, at) => at !== index) })}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={() => onPatch({ fields: [...fields, { key: "", value: "" }] })}
      >
        <Plus className="size-3.5" aria-hidden />
        Add a field
      </Button>
      <p className="text-xs text-muted-foreground">
        Field <strong>names</strong> are kept as metadata so a row is recognisable; the values are sealed with the
        rest of the secret. Only a plugin provider reads these.
      </p>
    </div>
  );
}

/**
 * 🔴 The claim and its contradiction are the same element.
 *
 * There is no arrangement of this form in which "encrypted before it is
 * written" is drawn while `enabled` is false: the other branch renders the
 * server's own warning, in the same place, in red.
 */
function EncryptionPanel({ encryption }: { encryption: EncryptionState }) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-xs",
        encryption.enabled
          ? "border-success/30 bg-success/5 text-success"
          : "border-destructive/30 bg-destructive/5 text-destructive",
      )}
    >
      {encryption.enabled ? (
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : (
        <LockOpen className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      )}
      <span>
        {encryption.enabled
          ? `What you paste is encrypted before it is written (${encryption.algorithm}, ${encryption.keyDerivation}).`
          : encryption.warning}
      </span>
    </p>
  );
}

/**
 * What the server made of it.
 *
 * Every line here comes back from the response, which means it is what will
 * actually be used — the domains the jar really covers, the count it really
 * held. It is the cheapest possible check that the right tab was exported.
 */
function SavedPanel({
  created,
  notice,
  onAnother,
  onDone,
}: {
  created: CredentialCreated;
  notice: string;
  onAnother: () => void;
  onDone: () => void;
}) {
  const { credential, encryption } = created;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-success" aria-hidden />
          Saved
        </DialogTitle>
        <DialogDescription>
          This is what the server read out of it — not an echo of what was typed, which is why it is worth looking
          at.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {credential.scope}
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {TYPE_LABEL[credential.type]}
          </Badge>
          {credential.label ? (
            <span className="text-xs font-normal text-muted-foreground">{credential.label}</span>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">{summaryFacts(credential).join(" · ")}</p>
        {credential.meta.expiresAt ? (
          <p className="text-xs text-muted-foreground">
            First cookie expires {new Date(credential.meta.expiresAt).toLocaleString()}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {encryption.enabled
            ? `Encrypted with ${encryption.algorithm} under key ${encryption.keyId}.`
            : encryption.warning}
        </p>
      </div>

      {credential.type === "cookies" ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{created.notice ?? notice}</span>
        </p>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onAnother}>
          Add another
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

/**
 * The domains in a pasted jar, read the same way the server reads them.
 *
 * ⚠️ Only for the hint beside the box. `#HttpOnly_` is stripped as the domain
 * prefix it is rather than skipped as a comment — the whole reason this is
 * written out rather than a one-line `split`.
 */
function domainsOf(text: string): string[] {
  const domains = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const withoutPrefix = trimmed.startsWith("#HttpOnly_") ? trimmed.slice("#HttpOnly_".length) : trimmed;
    if (withoutPrefix.startsWith("#")) continue;
    const domain = withoutPrefix.split("\t")[0]?.trim();
    if (domain && domain !== "" && !domain.includes(" ")) domains.add(domain);
  }
  return [...domains].sort();
}
