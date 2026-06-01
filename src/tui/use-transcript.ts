// tui/use-transcript.ts — the rendered transcript: finished scrollback + live turn.
//
// Finished items live in `history` (rendered in Ink's <Static> scrollback); the
// in-flight turn accumulates in `live` and is moved into `history` as it finalises.
// `push`/`note` append finished items; `nextId` hands out stable item ids. These
// are the primitives the approval gate (for error notes) and the agent engine build
// on, so they live in their own small hook that depends on nothing else.

import { useRef, useState } from "react";
import type { Item, ItemInput } from "./Message.tsx";

export interface Transcript {
  history: Item[];
  setHistory: React.Dispatch<React.SetStateAction<Item[]>>;
  live: Item[];
  setLive: React.Dispatch<React.SetStateAction<Item[]>>;
  /** Append a finished item to the scrollback. */
  push: (item: ItemInput) => void;
  /** Append an info/error note to the scrollback. */
  note: (text: string, tone?: "info" | "error") => void;
  /** Hand out the next stable item id. */
  nextId: () => number;
}

export function useTranscript(opts: {
  /** The launch banner — the first <Static> item, so it scrolls away naturally. */
  banner: Extract<ItemInput, { kind: "banner" }>;
  /** Startup notes (context/skills/mcp) shown right after the banner. */
  startupNotes: string[];
}): Transcript {
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  const [history, setHistory] = useState<Item[]>(() => [
    { ...opts.banner, id: nextId() } as Item,
    ...opts.startupNotes.map(
      (text) => ({ id: nextId(), kind: "note" as const, text }) as Item,
    ),
  ]);
  const [live, setLive] = useState<Item[]>([]);

  const push = (item: ItemInput) =>
    setHistory((prev) => [...prev, { ...item, id: nextId() } as Item]);
  const note = (text: string, tone: "info" | "error" = "info") =>
    push({ kind: "note", text, tone });

  return { history, setHistory, live, setLive, push, note, nextId };
}
