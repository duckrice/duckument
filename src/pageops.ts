// Rearranging a document's pages. Each operation returns a new state in
// which the items added to the pages have moved along with their page.

import { newId, type Item, type PageRef } from "./model";
import type { DocState } from "./store";

/** Renumbers the items' pages; items whose page maps to null are dropped. */
function remap(items: Item[], newIndex: (oldIndex: number) => number | null): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    const page = newIndex(item.page);
    if (page === null) continue;
    out.push(page === item.page ? item : ({ ...item, page } as Item));
  }
  return out;
}

/** Where each page of `before` ends up in `after`, by id. */
function mapping(before: PageRef[], after: PageRef[]) {
  const position = new Map(after.map((page, index) => [page.id, index]));
  return (oldIndex: number) => position.get(before[oldIndex]?.id) ?? null;
}

function rearranged(state: DocState, pages: PageRef[]): DocState {
  return { pages, items: remap(state.items, mapping(state.pages, pages)) };
}

/**
 * Moves the pages with the given ids so they sit, in their current order,
 * before the page that is at position `to` now (or at the end).
 */
/** Pages (by id) in groups for separate files: a new group every `every` pages, or at each of `starts`. */
export function splitGroups(ids: string[], how: { every: number } | { starts: string[] }): string[][] {
  const groups: string[][] = [];
  ids.forEach((id, i) => {
    if (!groups.length || ("every" in how ? i % how.every === 0 : how.starts.includes(id))) groups.push([]);
    groups[groups.length - 1].push(id);
  });
  return groups;
}

export function movePages(state: DocState, ids: string[], to: number): DocState {
  const moving = state.pages.filter((page) => ids.includes(page.id));
  if (!moving.length) return state;
  const before = state.pages.slice(0, to).filter((page) => !ids.includes(page.id));
  const after = state.pages.slice(to).filter((page) => !ids.includes(page.id));
  const pages = [...before, ...moving, ...after];
  if (pages.every((page, i) => page === state.pages[i])) return state;
  return rearranged(state, pages);
}

/** Removes pages, and what was added to them. A document keeps at least one page. */
export function deletePages(state: DocState, ids: string[]): DocState {
  const pages = state.pages.filter((page) => !ids.includes(page.id));
  if (!pages.length || pages.length === state.pages.length) return state;
  return rearranged(state, pages);
}

/** Turns pages by a multiple of 90 degrees (positive is clockwise). */
export function rotatePages(state: DocState, ids: string[], degrees: number): DocState {
  if (!ids.length || degrees % 360 === 0) return state;
  return {
    items: state.items,
    pages: state.pages.map((page) =>
      ids.includes(page.id) ? { ...page, rotation: (((page.rotation + degrees) % 360) + 360) % 360 } : page,
    ),
  };
}

/** Puts new pages in at position `at`. */
export function insertPages(state: DocState, at: number, added: PageRef[]): DocState {
  if (!added.length) return state;
  const index = Math.max(0, Math.min(at, state.pages.length));
  return rearranged(state, [...state.pages.slice(0, index), ...added, ...state.pages.slice(index)]);
}

/** A reference to every page of a PDF, in order. */
export function pagesOf(source: string, count: number): PageRef[] {
  return Array.from({ length: count }, (_, index) => ({ id: newId(), source, index, rotation: 0 }));
}

export function blankPage(width: number, height: number): PageRef {
  return { id: newId(), source: "", index: 0, rotation: 0, blank: { width, height } };
}

/** The items on a set of pages, renumbered as if those pages were the whole document. */
export function itemsFor(state: DocState, ids: string[]): Item[] {
  const kept = state.pages.filter((page) => ids.includes(page.id));
  return remap(state.items, mapping(state.pages, kept));
}
