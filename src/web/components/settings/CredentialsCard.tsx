/**
 * Credentials, on the Settings screen.
 *
 * The store, the encryption and the endpoints existed before this card did, and
 * there was no way to reach any of it from a browser: the answer to "where do I
 * put my cookies?" was *nowhere*. This is that answer.
 *
 * ## The three things it has to say out loud
 *
 * 🔴 **Whether the secrets are actually encrypted.** `encryption.enabled` comes
 * back on every listing precisely so this screen cannot claim "encrypted at
 * rest" while `CREDENTIALS_KEY` is unset. When it is false the server's own
 * warning is rendered instead of the claim — never both, never neither.
 *
 * 🔴 **That cookies are a mitigation, not a fix.** They expire within hours and
 * replaying them from another IP is itself a signal (PLAN §15). The sentence
 * comes from the server as `notice`, sits beside the cookie box in the form,
 * and repeats under the list wherever a cookie credential is on screen.
 *
 * 🔴 **That the order of the list is the order of resolution.** The server
 * sorts most-specific-scope first, which is exactly how a URL is matched. The
 * rows are numbered and the rule is written above them, because a list that
 * happens to be in precedence order and does not say so is a list somebody will
 * re-sort by date one day.
 *
 * ## And one it must not say
 *
 * There is no secret on this screen, in any form — no value, no prefix, no
 * field of dots suggesting one could be recovered. Everything a row draws is
 * metadata the server derived at write time: `cookieCount`, `domains`,
 * `expiresAt`, `sessionCookies`, `username`, `fields`. Without those a row is
 * "cookies for youtube.com", which is indistinguishable from the other three
 * rows that say "cookies for youtube.com".
 */
import { useState } from "react";
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  Plus,
  Send,
  Stethoscope,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { CredentialMetadata } from "../../../core/credentials";
import type { EncryptionState } from "../../data/credentials";
import { useCredentials, useDeleteCredential, useTestCredential } from "../../data/credentials";
import { formatDateTime, formatRelative } from "../../data/format";
import { EmptyState, ErrorState } from "../common/Bits";
import { CredentialDialog } from "./CredentialDialog";
import { TelegramLoginDialog } from "./TelegramLoginDialog";
import {
  TYPE_LABEL,
  cookieExpiry,
  describeScope,
  summaryFacts,
  type CredentialTone,
} from "./credential-view";

const TONE_TEXT: Record<CredentialTone, string> = {
  ok: "text-success",
  warn: "text-warning",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

/**
 * Encryption, as it actually is.
 *
 * ⚠️ The two branches are deliberately not a green tick and a smaller green
 * tick. Unset means every cookie, password and key in the database is readable
 * by anything that can read the file — that is a red panel carrying the
 * server's wording, not a note.
 */
function EncryptionBanner({ encryption }: { encryption: EncryptionState }) {
  if (encryption.enabled) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-xs text-success">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          <strong>Encrypted at rest.</strong> {encryption.algorithm}, key derived by {encryption.keyDerivation},
          under key <code className="font-mono">{encryption.keyId}</code>. Each credential records which key
          sealed it, so a changed <code>CREDENTIALS_KEY</code> is a diagnosable state rather than an unexplained
          failure.
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
      <LockOpen className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        {/* The server's sentence, verbatim. It is the one that is true. */}
        <strong>Not encrypted. </strong>
        {encryption.warning}{" "}
        <span className="opacity-90">
          Set it in <code>docker-compose.yml</code> — see <code>docs/DEPLOY.md § Credentials at rest</code>.
        </span>
      </span>
    </p>
  );
}

/** One check from `POST /api/credentials/:id/test`, with its own name and sentence. */
function CheckLine({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      {ok ? (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
      ) : (
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
      )}
      <span className="min-w-0">
        <span className="font-medium">{name}</span> — <span className="text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
}

function CredentialRow({
  credential,
  position,
  currentKeyId,
  onDelete,
}: {
  credential: CredentialMetadata;
  position: number;
  currentKeyId: string | null;
  onDelete: () => void;
}) {
  const test = useTestCredential();
  const report = test.data ?? null;
  const expiry = credential.type === "cookies" ? cookieExpiry(credential.meta, Date.now()) : null;
  // A row sealed under a key that is no longer running cannot be decrypted, and
  // the failure would otherwise arrive as an unexplained download error.
  const wrongKey = credential.encrypted && credential.keyId !== null && credential.keyId !== currentKeyId;

  return (
    <li className="flex flex-wrap items-start gap-3 py-3 sm:flex-nowrap">
      <span
        className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold tabular-nums"
        title="Position in the resolution order"
      >
        {position}
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <code className="font-mono">{credential.scope}</code>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {TYPE_LABEL[credential.type]}
          </Badge>
          {credential.label ? (
            <span className="text-xs font-normal text-muted-foreground">{credential.label}</span>
          ) : null}
          {credential.encrypted ? null : (
            <Badge variant="secondary" className="bg-destructive/12 px-1.5 py-0 text-[10px] text-destructive">
              plain text
            </Badge>
          )}
        </p>

        <p className="text-xs text-muted-foreground">{describeScope(credential.scope)}</p>
        <p className="text-xs text-muted-foreground">{summaryFacts(credential).join(" · ")}</p>

        {expiry ? <p className={cn("text-xs font-medium", TONE_TEXT[expiry.tone])}>{expiry.text}</p> : null}

        {wrongKey ? (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            Sealed with key <code className="font-mono">{credential.keyId}</code>, and the server is running{" "}
            <code className="font-mono">{currentKeyId ?? "no key"}</code>. Save it again to re-seal it.
          </p>
        ) : null}

        <p className="text-[11px] text-muted-foreground">
          Added {formatDateTime(credential.createdAt)} · Updated {formatDateTime(credential.updatedAt)} ·{" "}
          {credential.lastUsedAt
            ? `last used by a download ${formatRelative(credential.lastUsedAt)}`
            : "never used by a download yet"}
        </p>

        <div className="flex flex-wrap items-center gap-1 pt-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 px-2 text-xs"
            disabled={test.isPending}
            onClick={() => test.mutate(credential.id)}
          >
            {test.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Stethoscope className="size-3.5" aria-hidden />
            )}
            Test
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" aria-hidden />
            Delete
          </Button>
        </div>

        {test.isError ? <p className="text-xs text-destructive">{test.error.message}</p> : null}

        {report ? (
          <div className="mt-1 space-y-1.5 rounded-lg border bg-muted/40 p-2.5">
            <p
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium",
                report.ok ? "text-success" : "text-destructive",
              )}
            >
              {report.ok ? (
                <CheckCircle2 className="size-3.5" aria-hidden />
              ) : (
                <XCircle className="size-3.5" aria-hidden />
              )}
              {report.ok ? "Usable, as far as can be told without asking the site" : "Not usable as it stands"}
            </p>
            <ul className="space-y-1">
              {report.checks.map((check) => (
                <CheckLine key={check.name} name={check.name} ok={check.ok} detail={check.detail} />
              ))}
            </ul>
            {report.warnings.map((warning) => (
              <p key={warning} className="flex items-start gap-1.5 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                {warning}
              </p>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Checked here, not against the site: a request would answer “the credential is wrong” and “this IP is
              being refused” with the same cross, and would spend the request that a bot challenge is punishing.
            </p>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Deleting, with the row named.
 *
 * A credential cannot be recovered from anywhere — the secret only ever existed
 * in the browser that pasted it — so the confirmation says what it is losing
 * rather than asking "are you sure?".
 */
function DeleteDialog({
  credential,
  onOpenChange,
}: {
  credential: CredentialMetadata | null;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteCredential();

  return (
    <Dialog open={credential !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this credential?</DialogTitle>
          <DialogDescription>
            {credential ? (
              <>
                <code className="font-mono">{credential.scope}</code> — {TYPE_LABEL[credential.type]}
                {credential.label ? ` (${credential.label})` : ""}. Downloads for that site go back to whatever
                less specific credential matches, or to none at all.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          The secret is not stored anywhere else and cannot be read back out of CasaTube, so this is not
          undoable: replacing it means pasting it again.
        </p>
        {remove.isError ? <p className="text-xs text-destructive">{remove.error.message}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            className="gap-1.5"
            disabled={remove.isPending || credential === null}
            onClick={() => {
              if (!credential) return;
              remove.mutate(credential.id, { onSuccess: () => onOpenChange(false) });
            }}
          >
            {remove.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="size-4" aria-hidden />
            )}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CredentialsCard() {
  const listing = useCredentials();
  const [adding, setAdding] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [deleting, setDeleting] = useState<CredentialMetadata | null>(null);

  const credentials = listing.data?.credentials ?? [];
  const hasCookies = credentials.some((credential) => credential.type === "cookies");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" aria-hidden />
          Credentials
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Per site and per type. This is what answers an age gate, a members-only upload and “Sign in to confirm
          you’re not a bot” — and it is stored one-way: what is pasted here goes to yt-dlp and comes back out
          nowhere.
        </p>
        <CardAction className="flex items-center gap-1.5">
          {/* 🔴 A button of its own rather than a type in the Add form. Telegram
              is the one credential nobody can *paste*: signing in takes a code
              Telegram sends while the server holds the connection open, so it is
              a conversation and not a field. Hiding that behind "Add → custom"
              would leave somebody looking for three values they have no way to
              produce. */}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={listing.isPending || listing.isError}
            onClick={() => setSigningIn(true)}
          >
            <Send className="size-3.5" aria-hidden />
            Telegram
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={listing.isPending || listing.isError}
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" aria-hidden />
            Add
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {listing.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : listing.isError ? (
          <ErrorState error={listing.error} what="Credentials" retry={() => void listing.refetch()} />
        ) : (
          <>
            <EncryptionBanner encryption={listing.data.encryption} />

            {credentials.length === 0 ? (
              <EmptyState
                icon={<KeyRound className="size-6" aria-hidden />}
                title="No credentials stored"
                hint="Downloads run signed out. That is fine until a video is age-gated, members-only or answered with a bot challenge — then a cookies.txt exported from a signed-in browser is what gets past it."
                action={
                  <Button size="sm" className="mt-2 gap-1.5" onClick={() => setAdding(true)}>
                    <Plus className="size-3.5" aria-hidden />
                    Add the first one
                  </Button>
                }
              />
            ) : (
              <>
                <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
                  <strong>This is the order they resolve in.</strong> The most specific site that matches a URL
                  wins — <code>www.youtube.com</code> before <code>*.youtube.com</code> before{" "}
                  <code>youtube.com</code>, and <code>*</code> last of all. The first row below whose site matches
                  is the credential a download uses.
                </p>

                <ul className="divide-y">
                  {credentials.map((credential, index) => (
                    <CredentialRow
                      key={credential.id}
                      credential={credential}
                      position={index + 1}
                      currentKeyId={listing.data.encryption.keyId}
                      onDelete={() => setDeleting(credential)}
                    />
                  ))}
                </ul>
              </>
            )}

            {hasCookies ? (
              // ⚠️ PLAN §15 again, where the cookie rows are — not only in the
              // form, because this is the screen somebody comes back to when a
              // download that worked yesterday stops working today.
              <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{listing.data.notice}</span>
              </p>
            ) : null}

            <p className="text-xs text-muted-foreground">
              A secret is never sent back: every field above is metadata the server derived when it was stored.
              There is nothing to reveal and nothing to edit — replacing one means pasting it again.
            </p>

            <CredentialDialog
              open={adding}
              onOpenChange={setAdding}
              notice={listing.data.notice}
              encryption={listing.data.encryption}
            />

            <TelegramLoginDialog
              open={signingIn}
              onOpenChange={setSigningIn}
              encryption={listing.data.encryption}
            />
          </>
        )}

        <DeleteDialog credential={deleting} onOpenChange={(open) => setDeleting(open ? deleting : null)} />
      </CardContent>
    </Card>
  );
}
