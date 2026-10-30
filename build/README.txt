Snapper - playtest capture for web games
========================================

Free and open source (MIT, see LICENSE.txt). Source and docs:
https://github.com/maximstark/snapper
Product page: https://maximstark.art/snapper/

First run
---------
Snapper is not code-signed yet, so Windows SmartScreen warns the first
time: click "More info", then "Run anyway". If you unzipped the portable
version, right-click the zip first, Properties, tick "Unblock", OK, then
extract it.

Playing
-------
1. Start Snapper. Under "Game folder", pick the folder that holds your
   game's index.html (or try one of the Demos), then press Play.
2. Play. When something looks wrong, press F8 and type what you saw.
   F9 shows the overlay; F10 pauses.
3. Close the window. The session is a folder of plain files in
   <game folder>\.snapper\sessions\ . Start with SESSION.md.

Snapper has no account and no telemetry. Nothing leaves your machine
unless you post a mark as an issue (snapper issue --github or --discord).

With an AI coding agent
-----------------------
"Set up for Claude" installs the Snapper skill into your game folder,
so Claude Code can read sessions, open the shots and replay marks.
"Copy for Claude" copies a one-line prompt for the selected session.
Other MCP clients: see "MCP server" in the README on GitHub.

Uninstall
---------
Settings > Apps > Installed apps > Snapper > Uninstall. Your sessions
stay in your game folders until you delete them.

Questions and bugs
------------------
https://github.com/maximstark/snapper/issues
maxim@maximstark.art
