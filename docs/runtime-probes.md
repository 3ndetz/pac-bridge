# Opt-in runtime probes

The normal Node test suite does not start these native SDK experiments. They are retained test source, not evidence that an installed runtime or a live authentication path is verified.

| Scenario | Additional opt-in |
| --- | --- |
| SDK empty snapshot | `PAC_TEST_SDK_SNAPSHOT=1` |
| SDK/source quiescence lease | `PAC_TEST_SDK_COORDINATED=1` |
| ACP-to-SDK query binding | `PAC_TEST_SDK_ACP_BINDING=1` |
| Native asynchronous-hook timing | `PAC_TEST_SYNTHETIC_CLAUDE=1` |
| Synthetic MCP controller/router | Linux and `PAC_TEST_SYNTHETIC_CLAUDE=1` |
| Synthetic Stop-hook continuation | Linux and `PAC_TEST_SYNTHETIC_CLAUDE=1` |

Review one scenario before enabling it. Run synthetic model scenarios only in an isolated environment without external network access and with disposable configuration directories. Existing login, proxy and installed MCP configuration files are outside these synthetic tests. A skipped test is not a successful runtime check. Do not run the fixture directory as a suite.
