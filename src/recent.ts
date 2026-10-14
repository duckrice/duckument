// The files opened most recently, shown on the start screen.

const KEY = "freepdfeditor.recent";
const MAX = 10;

export interface RecentFile {
  path: string;
  name: string;
}

export function loadRecent(): RecentFile[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((f) => typeof f?.path === "string") : [];
  } catch {
    return [];
  }
}

function store(list: RecentFile[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Not remembering is fine.
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Puts a file at the top of the list. */
export function addRecent(path: string, name: string) {
  store([{ path, name }, ...loadRecent().filter((f) => !same(f.path, path))]);
}

export function removeRecent(paths: string[]) {
  store(loadRecent().filter((f) => !paths.some((p) => same(f.path, p))));
}
