# Telegram completion notifications

The optional source-side sender runs after a successful OpenCode turn routed through the bridge, including PAC and native model turns, and sends an excerpt of the answer to the configured Telegram chat. It does not run for cancelled or failed turns. Messages are subject to the sender's redaction and length limits; the chat receives answer content, so use a trusted destination. Delivery failure is recorded locally and does not make a completed model turn fail or retry the turn.

For an installed Windows PAC Bridge profile, prepare a private UTF-8 file containing `TG_BOT_TOKEN` and `TG_CHAT_ID` in `NAME=value` form. Obtain those values through a secure channel; never commit them, place them in a public release, or paste them into chat. Run under the account that owns the profile:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Enable-TelegramNotify.ps1 `
  -TelegramConfigPath C:\Private\telegram.env
```

The script protects the local notification directory, copies the sender and credentials there, and configures the existing PAC OpenCode wrapper. It refuses to overwrite an existing notification setup. The change applies to new PAC chats; existing processes keep their previous environment. Delivery results are recorded in the private profile's `notify/tg-notify.log` without tokens.

On other platforms, `scripts/telegram-notify.cjs` reads the private `tg-notify.env` in `PAC_TELEGRAM_DIR`, or in `~/.hapi-servermall/pac-bridge/notify` by default. Configure `PAC_TURN_NOTIFY_SCRIPT` to the absolute path of the sender in the source runner's environment before starting it. This path is experimental until that platform's full HAPI deployment is verified.
