export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@modelcontextprotocol/')) throw new Error('MCP dependency was loaded')
  return nextResolve(specifier, context)
}
