# Operating the experimental ACP bridge

The source HAPI runner, the relay and each authenticated controller are separate
processes. Restarting one does not require registering another HAPI machine.
Retain the previous runtime, source configuration and relay until existing
sessions have finished; a session established through an old relay cannot be
assumed to survive a relay cutover.

Use an authenticated TLS relay with a stable address, a private authorization
file containing token hashes, and private key files readable only by the service
account. A service manager should start the relay after networking and restart
it after failure. Persist its code, Node runtime, certificate and authorization
file outside temporary directories. Preserve token and certificate identity
when moving existing clients.

The controller must run as the same operating-system user who authenticated
Claude Code. Its service or scheduled task needs a stable Node runtime, the
bridge adapter and dependencies, its private agent token, the trusted relay
certificate, and `PAC_AGENT_RECONNECT=1`. On Windows an interactive logon task
requires that user to be logged in; this does not establish unattended boot
operation. Configure restart after failure and propagate the child exit status.

The source profile needs stable copies of the PAC adapter, dependencies, source
token and trusted certificate. Its existing HAPI runner must inherit those paths
and the relay address before it starts. Retain its machine identity, existing
workspace roots and native models. Do not publish tokens, credentials, private
keys or individual installation paths in the repository.

Verify each change in order: relay and controller readiness, model discovery,
a real source file operation and visible answer through the existing HAPI
machine, then recovery after independently restarting relay and controller.
Archive only the disposable verification session. A service restart is not a
reboot test; logon and reboot recovery require their own verification.
