# Security Policy

Harpy is a self-hosted control plane: it runs shells, spawns coding-agent
CLIs, and serves a workspace over HTTP/WebSocket. That makes the security
boundary important — please read this before deploying or reporting.

## Supported versions

Security fixes land on the latest release line. Keep installations current with
`harpy update` or by reinstalling the npm package / pulling the repository.

| Version | Supported |
| ------- | --------- |
| latest release | ✅ |
| older releases | ❌ |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security reports.

- Email the maintainer via the contact address on the
  [GitHub profile](https://github.com/alicomert), or
- use GitHub's private vulnerability reporting on the repository if enabled.

Include: affected version, reproduction steps or proof-of-concept, the impact
(remote code execution, auth bypass, information disclosure, …), and any logs
with secrets redacted. You will get an acknowledgment as soon as possible and a
coordinated disclosure timeline once a fix is ready.

## Deployment guidance

- Harpy binds `0.0.0.0` by default. On a public host, restrict access with a
  firewall, VPN, or a trusted reverse proxy — or use the built-in share tunnel
  intentionally.
- Always set a strong owner password on first run.
- `hp_` API keys grant the same surface as a logged-in user; treat them like
  passwords and rotate them if exposed.
- The public-link feature exposes the full authenticated UI to anyone who can
  log in — enable it only with member allowlists configured if non-admins share
  the instance.
- Agent sessions execute real CLIs with the daemon's permissions. Member
  accounts can only reach workspaces and agents you allowlist.

## Scope notes

By design, an authenticated admin can run arbitrary commands through terminals
and agents — that is the product. Reports should target crossing the *stated*
boundaries: unauthenticated access, member→admin escalation, workspace escape
past an allowlist, secret disclosure, or remote compromise of the daemon itself.
