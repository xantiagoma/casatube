/**
 * The handful of things that genuinely belong to this browser.
 *
 * 🔴 R3 is about *work*: no download decision is taken here and nothing in this
 * file survives being wrong — clearing it leaves the app identical, because the
 * server still holds every job, every source and every default. What lives here
 * is which tab was open and how the last form was filled, so the next one does
 * not start from nothing.
 *
 * Everything else — job state, library contents, preferences the worker acts on
 * — comes from the server on every load.
 */
import { useCallback, useState } from "react";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function useLocalPref<T>(key: string, fallback: T): [T, (next: T) => void] {
  const storageKey = `casatube.${key}`;
  const [value, setValue] = useState<T>(() => read(storageKey, fallback));

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // A preference that does not persist is still a preference.
      }
    },
    [storageKey],
  );

  return [value, update];
}
