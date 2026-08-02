# Power Assistant MCP server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes your Power Assistant Obsidian vault to Claude Desktop and Claude Code,
so you can ask about your meetings, notes, and bills from outside Obsidian. It
reads the vault's Markdown directly (read-only), so it works whether or not
Obsidian is open.

## Tools

- **search_notes** — keyword search across the vault, returns paths and excerpts.
- **read_note** — the full Markdown of one note by path.
- **list_recent_notes** — the most recently edited notes.
- **finances_summary** — totals per currency and bills due, from processed documents.

## Install

```
cd mcp
npm install
```

## Connect it

Point the server at your vault (the folder that contains `.obsidian`). On
Windows that is your `D:\Obsidian\Steve` vault.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "power-assistant": {
      "command": "node",
      "args": ["D:\\repos\\Obisidian\\power-assistant\\mcp\\server.mjs", "D:\\Obsidian\\Steve"]
    }
  }
}
```

Restart Claude Desktop; the tools appear under the plug icon.

### Claude Code

```
claude mcp add power-assistant -- node D:\repos\Obisidian\power-assistant\mcp\server.mjs D:\Obsidian\Steve
```

Instead of passing the vault path as an argument you can set the
`POWER_ASSISTANT_VAULT` environment variable.

## Notes

- Read-only: it never writes to the vault.
- It skips `.obsidian`, `.trash`, `.git`, and `node_modules`.
- The note list refreshes on each call, so edits show up without a restart.
