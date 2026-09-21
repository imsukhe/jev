# Security policy

Do not report provider keys, gateway credentials, session transcripts, source code, or project paths in public issues.

Report a security concern privately to the future repository maintainers. Until a public security contact exists, do not open an issue containing sensitive material.

Mode-switching, the usage ledger, and reporting are local and need no credential. The one exception: `jev compact` and the opt-in Claude Code compaction hook call TypeSafe's JEV model, using your own `TYPESAFE_API_KEY` or Vercel AI Gateway credential, and send tool call inputs and tool result text over the network to do it. This is off by default (`jev compaction off`) and is the only network call this repository makes. This project is an independent client of TypeSafe's and Vercel's public APIs, not affiliated with either. See [compaction](README.md#compaction).

`TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY`, and `VERCEL_OIDC_TOKEN` belong in your environment or the host's secret manager, never in `.jev/config.json`, a plugin manifest, or a repository file.
