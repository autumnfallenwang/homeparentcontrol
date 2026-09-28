"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type DeviceCard, getSetup, getToday } from "../../lib/parent-api.js";
import {
  type ChildRow,
  childrenNeedingYou,
  pickChild,
  VIEWING_KEY,
} from "../../lib/selected-child.js";

/**
 * The child every main page is about — homework's "Viewing" switch.
 *
 * One provider for the whole shell, so the sidebar and the page can never
 * disagree about whose Today, Rules or Activity is on screen.
 */

type Setup = Awaited<ReturnType<typeof getSetup>>;

export interface Viewing {
  /** Null until the first load finishes. */
  children: ChildRow[] | null;
  /** Every device in the household, with its child and status. */
  devices: Setup["devices"];
  /** The child on screen; null only when the household has none. */
  child: ChildRow | null;
  select: (childId: string) => void;
  /** Children with a device that needs a person — marked in the switch. */
  needsYou: ReadonlySet<string>;
  /** Re-read after Settings adds a child or a device. */
  refresh: () => Promise<void>;
  /**
   * A page that just fetched `/today` hands it over, so the marks in the
   * switch match what that page is showing right now.
   */
  noteToday: (cards: DeviceCard[]) => void;
  error: unknown;
}

/**
 * ⚠️ Slow on purpose. This only feeds the switch's "needs you" marks; each
 * page polls its own data at its own rate. Two fast pollers for one number
 * is how a page left open on a tablet becomes a load problem.
 *
 * ⚠️ But slow alone was wrong: on the first walk Today said "Lucy: all
 * clear" while the switch beside it still marked Lucy "needs you" — the same
 * Mac, two answers, for up to a minute. Today now passes its own fresh
 * `/today` in through `noteToday`, so on that page the two cannot disagree.
 */
const REFRESH_MS = 60_000;

const ViewingContext = createContext<Viewing | null>(null);

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(VIEWING_KEY);
  } catch {
    return null;
  }
}

function save(childId: string): void {
  try {
    window.localStorage.setItem(VIEWING_KEY, childId);
  } catch {
    // Private window: the choice lasts until the tab closes.
  }
}

export function ViewingProvider({ children: content }: { children: ReactNode }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [cards, setCards] = useState<DeviceCard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextSetup, today] = await Promise.all([getSetup(), getToday()]);
      setSetup(nextSetup);
      setCards(today.devices);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Re-check the choice whenever the household changes: a saved child that
  // no longer exists must not leave every page empty.
  useEffect(() => {
    if (!setup) return;
    setSelectedId((current) => pickChild(current ?? readSaved(), setup.children, setup.devices));
  }, [setup]);

  const select = useCallback((childId: string) => {
    setSelectedId(childId);
    save(childId);
  }, []);

  const noteToday = useCallback((next: DeviceCard[]) => setCards(next), []);

  const value = useMemo<Viewing>(() => {
    const children = setup?.children.map(({ id, displayName }) => ({ id, displayName })) ?? null;
    return {
      children,
      devices: setup?.devices ?? [],
      child: children?.find((child) => child.id === selectedId) ?? null,
      select,
      needsYou: childrenNeedingYou(cards),
      refresh,
      noteToday,
      error,
    };
  }, [setup, cards, selectedId, select, refresh, noteToday, error]);

  return <ViewingContext.Provider value={value}>{content}</ViewingContext.Provider>;
}

export function useViewing(): Viewing {
  const value = useContext(ViewingContext);
  if (!value) throw new Error("useViewing() outside <ViewingProvider>");
  return value;
}
