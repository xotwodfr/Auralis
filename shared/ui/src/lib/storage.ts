// Minimal IndexedDB key-value store (ARCHITECTURE.md §6: "remember" persistence).
const DB_NAME = 'auralis'
const STORE = 'kv'

let db: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      db = undefined
      reject(req.error)
    }
  })
  return db
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode)
    const req = op(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}

export const kvGet = <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key))
export const kvSet = (key: string, value: unknown) => run('readwrite', (s) => s.put(value, key))
export const kvDelete = (key: string) => run('readwrite', (s) => s.delete(key))
