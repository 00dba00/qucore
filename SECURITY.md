# Security policy

QuCore stores database connections and runs SQL against your servers, so security reports are welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

Include the QuCore version, your OS, the steps to reproduce and what an attacker could achieve. You will get an answer within a few days; a fix is released as a new version and credited in the changelog unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes.

## How QuCore protects your data

- Passwords are encrypted with the operating system (Windows DPAPI, macOS Keychain, Linux secret service). On Linux without a keyring they can only be stored obfuscated, and the connection dialog warns about it.
- The UI runs in a sandboxed renderer with context isolation and a strict Content Security Policy; it loads no remote content.
- The UI can read and write only files the user chose (open dialog, save-as, drag and drop).
- Values entered in the app are sent to databases as parameters or escaped literals; identifiers are quoted per dialect.
- Query history, saved queries and the text of open tabs are stored **unencrypted** in the app profile. See the user guide, chapter "Where your data is".
