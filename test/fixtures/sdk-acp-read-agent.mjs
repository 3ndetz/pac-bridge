// Keep test-only latency out of the controller adapter.
if (process.env.PAC_TEST_BACKGROUND === '1') process.env.PAC_TEST_BACKGROUND_DELAY = '1'
await import('../../adapters/pac-claude-agent.mjs')
