/**
 * Where the file lands — chosen from the folders that exist, not typed blind.
 *
 * The old field was free text with a placeholder, which is the same fault as
 * the fixed resolution list: it asks for a decision without showing the
 * options. Now it lists the library.
 *
 * ⚠️ **The listing is allowed to fail, and the field still has to work.** The
 * library is usually a network mount; when it is asleep the request comes back
 * `MountUnavailable` (the route puts a deadline on the filesystem call). The
 * fallback is a plain text box — which is not so much a degraded mode as the
 * old behaviour, and it still queues correctly, because the move stage creates
 * whatever folder it is given.
 */
import { useState } from "react";

import { failureOf } from "../data/client";
import { useCreateDestination, useDestinations } from "../data/queries";

/** Not a path — `""` is the library root, so the sentinel has to be unusable. */
const NEW_FOLDER = " new";

interface Props {
  value: string;
  onChange(destination: string): void;
}

function messageOf(error: Error | null): string | null {
  if (!error) return null;
  return failureOf(error)?.message ?? error.message;
}

export function DestinationPicker({ value, onChange }: Props): React.JSX.Element {
  const listing = useDestinations();
  const create = useCreateDestination();
  const [typing, setTyping] = useState(false);

  const folders = listing.data?.folders ?? [];
  const listingError = messageOf(listing.error);
  // A value that is not in the list is a folder the user is inventing, so the
  // field has to stay a text box or it would silently drop what they typed.
  const known = value === "" || folders.some((folder) => folder.path === value);
  const asText = typing || !known || listingError !== null;

  const onPick = (picked: string): void => {
    if (picked === NEW_FOLDER) {
      setTyping(true);
      onChange("");
      return;
    }
    onChange(picked);
  };

  const onCreated = (made: { path: string }): void => {
    setTyping(false);
    onChange(made.path);
  };

  return (
    <div>
      <label htmlFor="destination">
        Destination folder
        <span className="hint">
          Inside the library{listing.data ? ` (${listing.data.root})` : ""}. Empty means the library root.
        </span>
      </label>

      {asText ? (
        <div className="row">
          <input
            id="destination"
            type="text"
            placeholder="youtube/talks"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <button
            type="button"
            className="small"
            disabled={value.trim() === "" || create.isPending}
            onClick={() => create.mutate(value, { onSuccess: onCreated })}
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
          {listingError === null && (
            <button
              type="button"
              className="small"
              onClick={() => {
                setTyping(false);
                onChange("");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <select id="destination" value={value} onChange={(event) => onPick(event.target.value)}>
          <option value="">Library root</option>
          {folders.map((folder) => (
            <option key={folder.path} value={folder.path}>
              {/* Prefixed rather than indented: a native select cannot nest, and
                  leading spaces collapse. The depth is what makes a long list
                  readable at all. */}
              {"– ".repeat(folder.depth - 1)}
              {folder.name}
            </option>
          ))}
          <option value={NEW_FOLDER}>+ New folder…</option>
        </select>
      )}

      {listing.isPending && <span className="hint">Reading the library…</span>}
      {listing.data?.truncated === true && <span className="hint">Only the first folders are listed.</span>}
      {listingError !== null && (
        <span className="hint">
          Could not read the library: {listingError} Type a folder name instead — it is created when the
          download finishes.
        </span>
      )}
      {create.error !== null && <span className="hint">Could not create it: {messageOf(create.error)}</span>}
      {create.data?.created === false && create.error === null && (
        <span className="hint">That folder already existed.</span>
      )}
    </div>
  );
}
