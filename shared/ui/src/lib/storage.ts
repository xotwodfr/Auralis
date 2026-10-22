// Minimal IndexedDB key-value stores (ARCHITECTURE.md §6: "remember" persistence). One database per owner, so a whole
// owner's data can be dropped without touching anyone else's.
const STORE = 'kv'

export function createKv(name: string) {
  let db: Promise<IDBDatabase> | undefined

  function open(): Promise<IDBDatabase> {
    db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1)
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

  return {
    get: <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key)),
    set: (key: string, value: unknown) => run('readwrite', (s) => s.put(value, key)),
    delete: (key: string) => run('readwrite', (s) => s.delete(key)),
    /** Deletes the whole database. The open connection is closed first, or the delete would be blocked by it. */
    async destroy(): Promise<void> {
      const open = db
      db = undefined
      ;(await open?.catch(() => undefined))?.close()
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(name)
        req.onsuccess = () => resolve()
        req.onblocked = () => resolve() // another tab still has it open; it is deleted once that tab closes it
        req.onerror = () => reject(req.error)
      })
    },
  }
}

const kv = createKv('auralis')
export const kvGet = kv.get
export const kvSet = kv.set
export const kvDelete = kv.delete

