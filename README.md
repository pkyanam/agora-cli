<div align="center">
  <h1>Agora CLI</h1>
  <p>Manage Agora payments from your terminal.</p>
  <p>
    <a href="https://github.com/pkyanam/agora-cli"><img alt="GitHub stars" src="https://img.shields.io/github/stars/pkyanam/agora-cli"></a>
    <a href="https://github.com/pkyanam/agora-cli/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/pkyanam/agora-cli"></a>
  </p>
</div>

![Agora overview page screenshot placeholder](assets/overview-placeholder.svg)

## Install

You need Node.js 20.9 or newer. Open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/agora-cli/main/install.sh | bash
```

## Connect

Run `agora auth login --url https://your-agora-address` and paste your API key when asked. Get an API key from the Agora Developers page. Then try:

```bash
agora products list
```

Run `agora --help` to see all commands. [Open an issue](https://github.com/pkyanam/agora-cli/issues) if you need help.
