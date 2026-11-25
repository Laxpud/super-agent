# Agent Studio

Agent Studio is a local, single-owner AI workspace in DeepSeek Harness. Talk to an Assistant or a project's current Leader in a sidebar entry separate from Workspaces. The Assistant can share a text conversation and pending questions with a bound Feishu bot. See the [setup and usage guide](docs/customization/agent-studio.md).

## GitHub Ticket orchestration

The optional **Agent Studio Tickets** panel manages a separate workflow for a single GitHub repository. It listens to GitHub and optionally Feishu, turns authorized requests into Tickets, runs each in its own DSH Session and directory, and answers in the original conversation. You do not need it to use the Agent Studio Assistant or project Leader.

The Ticket workflow inherits from the [upstream dsh-superagent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), not an official DeepSeek product. The upstream source was adapted for publication; *Exploring Super-agent Design: Towards a More Autonomous Agent System* also describes directions not implemented in that prototype. Review and adapt research code for your own environment.

To configure Ticket orchestration with a coding agent, ask:

> Read SETUP.md in this repository and set up Agent Studio Ticket orchestration with me.

[SETUP.md](SETUP.md) is the operator interview and installation guide for this optional service.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): Ticket orchestration setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
