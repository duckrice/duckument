import type { Item } from "./model";

export type Tool =
  | "select"
  | "text"
  | "check"
  | "cross"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "pen"
  | "whiteout"
  | "place";

/**
 * The items added to the open document, with undo history. Items and the
 * array holding them are never mutated, so a history entry is just a reference
 * to an earlier array.
 */
export class Store {
  items: Item[] = [];
  selectedId: string | null = null;

  private committed: Item[] = this.items;
  private saved: Item[] = this.items;
  private undoStack: Item[][] = [];
  private redoStack: Item[][] = [];
  private listeners = new Set<() => void>();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
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

  /** Turns the changes since the last commit into one undo step. */
  commit() {
    if (this.items === this.committed) return;
    // Adding something and removing it again leaves nothing to undo.
    if (this.items.length === this.committed.length && this.items.every((item, i) => item === this.committed[i])) {
      this.items = this.committed;
      return;
    }
    this.undoStack.push(this.committed);
    this.redoStack = [];
    this.committed = this.items;
    this.emit();
  }

  /** Drops the changes since the last commit. */
  revert() {
    if (this.items === this.committed) return;
    this.items = this.committed;
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
    this.items = this.committed = previous;
    this.emit();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.committed);
    this.items = this.committed = next;
    this.emit();
  }

  get dirty() {
    return this.committed !== this.saved;
  }

  markSaved() {
    this.saved = this.committed;
    this.emit();
  }

  reset() {
    this.items = this.committed = this.saved = [];
    this.undoStack = [];
    this.redoStack = [];
    this.selectedId = null;
    this.emit();
  }
}
