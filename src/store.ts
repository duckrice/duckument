import type { Item, PageRef } from "./model";

export type Tool =
  | "select"
  | "text"
  | "edit"
  | "markup"
  | "note"
  | "check"
  | "cross"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "pen"
  | "whiteout"
  | "place";

/** Everything about a document that can be undone. */
export interface DocState {
  items: Item[];
  pages: PageRef[];
}

/**
 * The open document's pages and the items added to them, with undo history.
 * Neither items nor the arrays holding them are ever mutated, so a history
 * entry is just a reference to an earlier state.
 */
export class Store {
  items: Item[] = [];
  pages: PageRef[] = [];
  selectedId: string | null = null;

  private committed: DocState = { items: this.items, pages: this.pages };
  private saved: DocState = this.committed;
  private undoStack: DocState[] = [];
  private redoStack: DocState[] = [];
  private listeners = new Set<() => void>();

  /** Calls `listener` after every change; returns a function that stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    if (this.selectedId && !this.get(this.selectedId)) this.selectedId = null;
    for (const listener of this.listeners) listener();
  }

  get(id: string): Item | undefined {
    return this.items.find((item) => item.id === id);
  }

  get selected(): Item | undefined {
    return this.selectedId ? this.get(this.selectedId) : undefined;
  }

  select(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit();
  }

  add(item: Item) {
    this.items = [...this.items, item];
    this.emit();
  }

  replace(item: Item) {
    this.items = this.items.map((other) => (other.id === item.id ? item : other));
    this.emit();
  }

  remove(id: string) {
    this.items = this.items.filter((item) => item.id !== id);
    this.emit();
  }

  /** Replaces the pages, and the items that move along with them, as one undo step. */
  apply(state: DocState) {
    if (state.pages === this.pages && state.items === this.items) return;
    this.pages = state.pages;
    this.items = state.items;
    this.commit();
    this.emit();
  }

  private get current(): DocState {
    return { items: this.items, pages: this.pages };
  }

  /** Turns the changes since the last commit into one undo step. */
  commit() {
    const { committed } = this;
    if (this.items === committed.items && this.pages === committed.pages) return;
    // Adding something and removing it again leaves nothing to undo.
    if (
      this.pages === committed.pages &&
      this.items.length === committed.items.length &&
      this.items.every((item, i) => item === committed.items[i])
    ) {
      this.items = committed.items;
      return;
    }
    this.undoStack.push(committed);
    this.redoStack = [];
    this.committed = this.current;
    this.emit();
  }

  /** Whether an item was already there at the last commit. */
  isCommitted(id: string): boolean {
    return this.committed.items.some((item) => item.id === id);
  }

  /** Drops the changes since the last commit. */
  revert() {
    if (this.items === this.committed.items && this.pages === this.committed.pages) return;
    this.restore(this.committed);
  }

  private restore(state: DocState) {
    this.items = state.items;
    this.pages = state.pages;
    this.emit();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.committed);
    this.committed = previous;
    this.restore(previous);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.committed);
    this.committed = next;
    this.restore(next);
  }

  get dirty() {
    return this.committed.items !== this.saved.items || this.committed.pages !== this.saved.pages;
  }

  markSaved() {
    this.saved = this.committed;
    this.emit();
  }

  /** Starts a new document with these pages and items, as saved. */
  reset(pages: PageRef[] = [], items: Item[] = []) {
    this.items = items;
    this.pages = pages;
    this.committed = this.saved = this.current;
    this.undoStack = [];
    this.redoStack = [];
    this.selectedId = null;
    this.emit();
  }
}
