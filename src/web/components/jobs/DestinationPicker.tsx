/**
 * Where the file lands: a folder that exists, or a name typed in.
 *
 * ⚠️ **The listing is allowed to fail and must not take the form with it.** The
 * library is usually a network mount, and a mount that is asleep answers slowly
 * or not at all. When it does, this falls back to a plain text field — which
 * still works, because the worker creates the folder at the move.
 */
import { useState } from "react";
import { FolderPlus, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateDestination, useDestinations } from "../../data/queries";

/** The library root, which has no name of its own. */
const ROOT = "__root__";

export function DestinationPicker({
  value,
  onChange,
  id = "destination",
}: {
  value: string;
  onChange(next: string): void;
  id?: string;
}) {
  const listing = useDestinations();
  const create = useCreateDestination();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");

  const folders = listing.data?.folders ?? [];
  const unavailable = listing.isError;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Destination folder</Label>

      {unavailable ? (
        <>
          <Input
            id={id}
            value={value}
            placeholder="subfolder/name — the library root if empty"
            onChange={(event) => onChange(event.target.value)}
          />
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            The library could not be listed. Type a name — the worker creates it when the file moves.
          </p>
        </>
      ) : (
        <div className="flex gap-2">
          <Select
            value={value === "" ? ROOT : value}
            onValueChange={(next) => onChange(next === ROOT ? "" : next)}
          >
            <SelectTrigger id={id} className="w-full">
              <SelectValue placeholder="Library root" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROOT}>Library root</SelectItem>
              {folders.map((folder) => (
                <SelectItem key={folder.path} value={folder.path}>
                  {folder.path}
                </SelectItem>
              ))}
              {/* A destination chosen before the listing loaded, or one that has
                  since been renamed, still has to be visible — otherwise the
                  select silently shows someone else's choice. */}
              {value !== "" && !folders.some((folder) => folder.path === value) && (
                <SelectItem value={value}>{value} (not listed)</SelectItem>
              )}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="New folder"
            onClick={() => setCreating((open) => !open)}
          >
            <FolderPlus className="size-4" aria-hidden />
          </Button>
        </div>
      )}

      {creating && !unavailable ? (
        <div className="flex gap-2 pt-1">
          <Input
            value={draft}
            placeholder="new-folder"
            onChange={(event) => setDraft(event.target.value)}
            aria-label="New folder name"
          />
          <Button
            type="button"
            variant="secondary"
            disabled={draft.trim() === "" || create.isPending}
            onClick={() => {
              const path = draft.trim();
              create.mutate(path, {
                onSuccess: () => {
                  onChange(path);
                  setDraft("");
                  setCreating(false);
                },
              });
            }}
          >
            Create
          </Button>
        </div>
      ) : null}

      {create.isError ? <p className="text-xs text-destructive">{create.error.message}</p> : null}
      {listing.data?.truncated ? (
        <p className="text-xs text-muted-foreground">
          Only part of the library was listed. Type a path if the one you want is missing.
        </p>
      ) : null}
    </div>
  );
}
