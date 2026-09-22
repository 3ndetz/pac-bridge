"""How a project's own wake loop hands its brain to the controller: one branch.

A typical loop builds a prompt from its inboxes and runs `claude -p ... --output-format
stream-json` inside the agent's container, reading the stream line by line for its log, its
token accounting and its timeouts. Everything stays as it was. Only the command changes: the same
flags run through brain/run in the controller, and the agent's container becomes the hands.
"""
import subprocess

CONTROLLER = "controller"                          # the container where Claude Code is logged in
RUN = "/opt/pac-bridge/brain/run"                  # brain/run, as the controller sees it
PROJECT = "/srv/my-project"                        # this project, as the controller sees it


def wake(agent: str, prompt: str, brain: str = "pac", fresh: bool = False, timeout: int = 1800):
    flags = ("-p " + ("" if fresh else "--continue ") +
             "--model sonnet --dangerously-skip-permissions --verbose "
             '--output-format stream-json "$PROMPT" </dev/null 2>&1')
    if brain == "claude":            # the old way: a login inside the agent's container
        cmd = ["docker", "exec", "-e", f"PROMPT={prompt}", f"agent-{agent}",
               "sh", "-c", f"cd /repo/agent/{agent} && timeout {timeout} claude {flags}"]
    else:                            # the controller's brain, this container's hands
        # opencode loads plugins lazily: touch it, then wait for the plugin's own mark.
        subprocess.run(["docker", "exec", f"agent-{agent}", "sh", "-c",
                        "curl -s -o /dev/null -m 150 http://127.0.0.1:4096/config; "
                        "for i in $(seq 75); do test -f /tmp/pac-bridge.connected && exit 0; sleep 2; done"])
        cmd = ["docker", "exec",
               "-e", f"PROMPT={prompt}",
               "-e", f"PAC_CLIENT={agent}",
               "-e", f"PAC_ROOT={PROJECT}", "-e", "PAC_ROOT_AS=/repo",
               "-e", f"PAC_CWD=/repo/agent/{agent}",
               "-e", f"PAC_RW=/repo/agent/{agent}",          # what the agent's container may write
               "-e", "PAC_MASK=/repo/.env=/repo/.env.masked", # what its container sees masked
               "-e", "PAC_HIDE=/repo/.git",                  # what its container does not see
               CONTROLLER, "sh", "-c", f"timeout {timeout} {RUN} {flags}"]
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, bufsize=1) as p:
        for line in p.stdout:        # the same stream-json lines either way
            print(line, end="")
