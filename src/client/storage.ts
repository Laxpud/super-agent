/** Adopt a saved Ticket-panel draft or route once; all subsequent writes use the new key. */
export function readPanelStorage(key: string): string | null {
  const saved = sessionStorage.getItem(key)
  const prefix = 'agent-studio/'
  if (saved !== null || !key.startsWith(prefix)) return saved
  const oldKey = `dsh-superagent/${key.slice(prefix.length)}`
  const old = sessionStorage.getItem(oldKey)
  if (old !== null) {
    sessionStorage.setItem(key, old)
    sessionStorage.removeItem(oldKey)
  }
  return old
}
