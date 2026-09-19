/**
 * Credentials, from the browser's side: metadata in, secrets only ever out.
 *
 * The API is one-way by construction — `GET /api/credentials` selects every
 * column except `secret`, and no response has a field a secret could travel in
 * (see `api/credentials.ts`). **This file must not invent one.** There is no
 * "reveal", no masked value to prefill a field with, and no cache entry
 * holding anything that was typed: a paste goes into the mutation and is gone
 * with the component that held it. Editing a credential is pasting it again.
 *
 * ## Two things the listing carries that the rows do not
 *
 * 🔴 `encryption` — whether `CREDENTIALS_KEY` is set, and the server's own
 * sentence for when it is not. The screen may only claim "encrypted at rest"
 * when `encryption.enabled` is true, and this is where that fact arrives.
 *
 * ⚠️ `notice` — cookies expire in hours and replaying them from another IP is
 * itself a signal (PLAN §15). It travels with the list rather than living in a
 * component's copy, so every screen that shows cookies has it to hand.
 *
 * They are fields of the same response on purpose: a component cannot render
 * the credentials while forgetting to fetch the qualification.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import type { CredentialMetadata, CredentialReport, CredentialType } from "../../core/credentials";
import { api, unwrap } from "./client";
import { keys } from "./keys";

/** What the server says about encryption at rest, on every listing. */
export interface EncryptionState {
  /** `false` means the secrets in the database are readable bytes. */
  enabled: boolean;
  algorithm: string | null;
  /** A non-reversible fingerprint of the key in force. Safe to display. */
  keyId: string | null;
  keyDerivation: string | null;
  /** The server's wording for "these are in plain text". Null when encrypted. */
  warning: string | null;
}

export interface CredentialListing {
  /**
   * 🔴 **Most specific scope first — the order they resolve in.** The server
   * sorts; the screen renders that order and says what it means. Re-sorting
   * here (by date, by type, by anything) would turn a precedence list into a
   * list that merely looks like one.
   */
  credentials: CredentialMetadata[];
  encryption: EncryptionState;
  notice: string;
  at: string;
}

export interface CredentialCreated {
  credential: CredentialMetadata;
  encryption: EncryptionState;
  /** Present for `cookies`, because that is where it has to be read. */
  notice?: string;
}

/**
 * The flat write shape, exactly as `POST /api/credentials` takes it.
 *
 * Flat rather than four shapes because that is what the route accepts — the
 * combination is validated on the server, and a 422 **names the field that is
 * missing**. That message is the useful half of the failure and gets rendered
 * verbatim; flattening it into "invalid" throws away the only part anyone can
 * act on.
 */
export interface CreateCredentialBody {
  scope: string;
  type: CredentialType;
  label?: string;
  cookies?: string;
  username?: string;
  password?: string;
  apiKey?: string;
  data?: Record<string, string>;
}

export function useCredentials(): UseQueryResult<CredentialListing, Error> {
  return useQuery({
    queryKey: keys.credentials,
    queryFn: async () => unwrap(await api.api.credentials.get()),
    retry: 0,
  });
}

/**
 * Store one.
 *
 * ⚠️ `(scope, type)` is unique on the server, so this **replaces** rather than
 * adding a second row — which is the point, since the common case is pasting a
 * fresh jar for a site that already has an expired one.
 */
export function useCreateCredential() {
  const client = useQueryClient();
  return useMutation<CredentialCreated, Error, CreateCredentialBody>({
    mutationFn: async (body) => unwrap(await api.api.credentials.post(body)),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.credentials }),
  });
}

export function useDeleteCredential() {
  const client = useQueryClient();
  return useMutation<{ deleted: boolean; id: string }, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.credentials({ id }).delete()),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.credentials }),
  });
}

// --- Signing in to Telegram ---------------------------------------------------

/**
 * What a login step answers with.
 *
 * 🔴 There is no `session` here, and there never will be. The server seals it
 * and answers with the credential's metadata — a session string is the whole
 * account, and the browser has no use for one (PLAN §12).
 */
export type TelegramLoginStep =
  | { state: "code-needed"; loginId: string; expiresAt: string }
  | { state: "password-needed"; loginId: string; expiresAt: string }
  | { state: "done"; account: string; credential: CredentialMetadata };

export interface TelegramStartBody {
  apiId: number;
  apiHash: string;
  phone: string;
}

/**
 * Ask Telegram to send a code.
 *
 * ⚠️ Each of these three is a *step*, not a form submission that can be retried
 * blindly: the server is holding a live MTProto connection between them, keyed
 * by `loginId`, because Telegram's code belongs to the connection that asked for
 * it. Starting again means a new code and a new `loginId`.
 */
export function useTelegramStart() {
  return useMutation<TelegramLoginStep, Error, TelegramStartBody>({
    mutationFn: async (body) => unwrap(await api.api.credentials.telegram.start.post(body)),
  });
}

export function useTelegramCode() {
  const client = useQueryClient();
  return useMutation<TelegramLoginStep, Error, { loginId: string; code: string }>({
    mutationFn: async (body) => unwrap(await api.api.credentials.telegram.code.post(body)),
    // A finished login wrote a credential; the list is stale either way.
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.credentials }),
  });
}

export function useTelegramPassword() {
  const client = useQueryClient();
  return useMutation<TelegramLoginStep, Error, { loginId: string; password: string }>({
    mutationFn: async (body) => unwrap(await api.api.credentials.telegram.password.post(body)),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.credentials }),
  });
}

/** Give up, so the server closes the connection instead of waiting it out. */
export function useTelegramCancel() {
  return useMutation<{ cancelled: boolean }, Error, string>({
    mutationFn: async (loginId) => unwrap(await api.api.credentials.telegram({ loginId }).delete()),
  });
}

/**
 * Check one, offline.
 *
 * The report is named checks — *readable*, *scope*, *expiry* — and each carries
 * its own sentence. It is a mutation rather than a query because it is
 * something a person asks for, and because the answer is about **now**: a jar
 * that passed an hour ago may have expired since.
 *
 * ⚠️ It makes no request to the site. That is deliberate (see
 * `core/credentials.ts`): a test that hit YouTube would answer "the credential
 * is wrong" and "the site is refusing this IP" with the same red cross.
 */
export function useTestCredential() {
  return useMutation<CredentialReport, Error, string>({
    mutationFn: async (id) => unwrap(await api.api.credentials({ id }).test.post()),
  });
}
