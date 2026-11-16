export function createUncertaintyNotifier({ notify, close }) {
  if (typeof notify !== 'function' || typeof close !== 'function') throw new Error('Invalid uncertainty notifier')
  let failed = false
  function failure() {
    if (failed) return
    failed = true
    close()
  }
  return {
    unknown(value) {
      if (failed) throw new Error('Availability transport is closed')
      try { notify(value) } catch (error) { failure(); throw error }
    },
    failure,
    get failed() { return failed },
  }
}
