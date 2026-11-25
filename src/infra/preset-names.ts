/** Decode preset IDs already recorded in DSH sessions. No old ID is registered for new sessions. */
export function currentPresetId(id: string | null): string | null {
  switch (id) {
    case 'dsh-superagent-studio-assistant': return 'agent-studio-assistant'
    case 'dsh-superagent-studio-leader': return 'agent-studio-leader'
    case 'dsh-superagent-managed-worker': return 'agent-studio-managed-worker'
    case 'dsh-superagent-worker': return 'agent-studio-worker'
    case 'dsh-superagent-router': return 'agent-studio-router'
    default: return id
  }
}
