export function browserWorkspaceDisposition({ creationAttempted, keep }) {
  if (creationAttempted !== false) return 'retain-review'
  return keep === true ? 'retain' : 'remove'
}
