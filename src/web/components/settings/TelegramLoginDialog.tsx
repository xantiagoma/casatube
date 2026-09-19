/**
 * Signing in to Telegram, as three steps instead of a terminal.
 *
 * 🔴 **The steps are the server's, not this component's.** Each one is a round
 * trip against a live MTProto connection the server is holding, because
 * Telegram's code belongs to the connection that asked for it. So `loginId` is
 * the thing that matters here and every screen below is a function of what the
 * last response said — never of a local guess about what should come next.
 *
 * ⚠️ Two consequences worth saying **on the screen** rather than leaving to be
 * discovered:
 *
 * - The login **expires**, because the connection is a resource somebody may
 *   have walked away from.
 * - It does **not survive a restart**, and a redeploy mid-login is a login to
 *   start again. Nothing is written until the last step, so there is nothing
 *   half-finished to clean up — but "unknown login" with no explanation would
 *   read as a bug.
 *
 * 📌 The session string never reaches this component. The server seals it and
 * answers with the credential's metadata (PLAN §12).
 */
import { useState } from "react";
import { CircleCheck, Loader2, Send, TriangleAlert } from "lucide-react";

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
import type { EncryptionState } from "../../data/credentials";
import {
  useTelegramCancel,
  useTelegramCode,
  useTelegramPassword,
  useTelegramStart,
} from "../../data/credentials";

type Stage =
  | { at: "start" }
  | { at: "code"; loginId: string; phone: string }
  | { at: "password"; loginId: string }
  | { at: "done"; account: string };

export function TelegramLoginDialog({
  open,
  onOpenChange,
  encryption,
}: {
  open: boolean;
  onOpenChange(next: boolean): void;
  encryption: EncryptionState;
}) {
  const [stage, setStage] = useState<Stage>({ at: "start" });
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");

  const start = useTelegramStart();
  const submitCode = useTelegramCode();
  const submitPassword = useTelegramPassword();
  const cancel = useTelegramCancel();

  const busy = start.isPending || submitCode.isPending || submitPassword.isPending;
  const error = start.error ?? submitCode.error ?? submitPassword.error ?? null;

  /**
   * ⚠️ Closing **cancels** an unfinished login rather than leaving it to expire.
   * The connection is the server's to hold, and five minutes of a socket for a
   * dialog somebody dismissed is five minutes of nothing.
   */
  function close(next: boolean): void {
    if (!next && (stage.at === "code" || stage.at === "password")) {
      cancel.mutate(stage.at === "code" ? stage.loginId : stage.loginId);
    }
    if (!next) {
      setStage({ at: "start" });
      setCode("");
      setPassword("");
      start.reset();
      submitCode.reset();
      submitPassword.reset();
    }
    onOpenChange(next);
  }

  /** One place reads a step, because every screen is a function of the answer. */
  function advance(step: { state: string; loginId?: string; account?: string }): void {
    if (step.state === "code-needed" && step.loginId) {
      setStage({ at: "code", loginId: step.loginId, phone });
    } else if (step.state === "password-needed" && step.loginId) {
      setStage({ at: "password", loginId: step.loginId });
    } else if (step.state === "done") {
      setStage({ at: "done", account: step.account ?? "your account" });
    }
  }

  const apiIdLooksRight = /^\d+$/.test(apiId.trim());
  const apiHashLooksRight = /^[0-9a-fA-F]{32}$/.test(apiHash.trim());

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign in to Telegram</DialogTitle>
          <DialogDescription>
            A private channel needs a signed-in session. Telegram sends a code to your phone, which is why this
            takes two steps rather than one form.
          </DialogDescription>
        </DialogHeader>

        {stage.at === "start" ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tg-api-id">api_id</Label>
                <Input
                  id="tg-api-id"
                  value={apiId}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="123456"
                  onChange={(event) => setApiId(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tg-api-hash">api_hash</Label>
                <Input
                  id="tg-api-hash"
                  value={apiHash}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="32 hex characters"
                  onChange={(event) => setApiHash(event.target.value)}
                />
              </div>
            </div>

            {/* 🔴 Said before it can go wrong. That page shows the two values
                beside a multi-line RSA public key, and pasting the key here is
                the single most likely mistake — it is not an input at all. */}
            <p className="text-xs text-muted-foreground">
              Both come from{" "}
              <a
                href="https://my.telegram.org"
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2"
              >
                my.telegram.org
              </a>{" "}
              → API development tools. ⚠️ Not the RSA public key on that page — it is never needed.
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="tg-phone">Phone number</Label>
              <Input
                id="tg-phone"
                value={phone}
                inputMode="tel"
                autoComplete="off"
                placeholder="+573001234567"
                onChange={(event) => setPhone(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                With the country code. Telegram sends the code to this account.
              </p>
            </div>

            {encryption.enabled ? null : (
              /* 🔴 The one thing this screen must never leave unsaid. A session
                 string is the whole account, and storing it readable is a
                 different decision from storing a site's cookies readable. */
              <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  <strong>CREDENTIALS_KEY is not set</strong>, so this session would be stored in plain text — and
                  a Telegram session is your whole account, not one site's cookies. Set it and restart before
                  signing in.
                </span>
              </p>
            )}
          </div>
        ) : null}

        {stage.at === "code" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tg-code">Code</Label>
              <Input
                id="tg-code"
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="12345"
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Sent to {stage.phone} — check Telegram itself, not SMS, if you are already signed in elsewhere.
            </p>
            {/* ⚠️ Both facts about the connection the server is holding. */}
            <p className="text-xs text-muted-foreground">
              This step expires in a few minutes, and a server restart ends it. Either way nothing is saved until
              it finishes, so starting again is safe.
            </p>
          </div>
        ) : null}

        {stage.at === "password" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tg-password">Two-step password</Label>
              <Input
                id="tg-password"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Your account has two-step verification on, so Telegram wants this as well as the code.
            </p>
          </div>
        ) : null}

        {stage.at === "done" ? (
          <p className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-success">
            <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Signed in as <strong>{stage.account}</strong>. The session is stored, sealed, scoped to{" "}
              <code>t.me</code> — private channel links will resolve through it. Revoke it any time from Telegram
              under Settings → Devices.
            </span>
          </p>
        ) : null}

        {error ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{error.message}</span>
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            {stage.at === "done" ? "Close" : "Cancel"}
          </Button>

          {stage.at === "start" ? (
            <Button
              disabled={busy || !apiIdLooksRight || !apiHashLooksRight || phone.trim().length < 5}
              onClick={() =>
                start.mutate(
                  { apiId: Number(apiId.trim()), apiHash: apiHash.trim(), phone: phone.trim() },
                  { onSuccess: advance },
                )
              }
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
              Send me a code
            </Button>
          ) : null}

          {stage.at === "code" ? (
            <Button
              disabled={busy || code.trim().length < 3}
              onClick={() =>
                submitCode.mutate({ loginId: stage.loginId, code: code.trim() }, { onSuccess: advance })
              }
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Sign in
            </Button>
          ) : null}

          {stage.at === "password" ? (
            <Button
              disabled={busy || password.length < 1}
              onClick={() =>
                submitPassword.mutate({ loginId: stage.loginId, password }, { onSuccess: advance })
              }
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Confirm
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
