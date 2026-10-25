/** Shares one confirmation between window close and app quit, before either tears down sessions. */
export function createCloseGuard(options: {
  isWorking(): boolean
  confirm(): Promise<boolean>
}): (event: { preventDefault(): void }, proceed: () => void) => boolean {
  let approved = false
  let pending = false
  return (event, proceed) => {
    if (approved || !options.isWorking()) return true
    event.preventDefault()
    if (!pending) {
      pending = true
      void options.confirm().then((close) => {
        if (close) {
          approved = true
          proceed()
        }
      }).catch(() => {
        // A failed dialog must leave running sessions intact.
      }).finally(() => { pending = false })
    }
    return false
  }
}
