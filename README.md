# Rustworks

A multiplayer factory game: mine bauxite, refine it into aluminium, build a liquid-fuel rocket and launch it at the bug colonies. Each new world is procedurally generated.

## Play online (single-player)

https://noahdemar.github.io/rustworks/

GitHub Pages only serves static files, so this version runs single-player and saves in your browser. Multiplayer needs the Node server below.

## Play locally / multiplayer

```bash
npm start
```

Open http://localhost:8080. Friends on the same network can join at `http://<your-LAN-IP>:8080`. The server prints the address when it starts.

If you open `index.html` directly, without the server, the game runs single-player and saves in your browser.

## Options

| Environment variable | Effect |
|---|---|
| `PORT` | Port to listen on (default 8080). |
| `WORLD_SEED` | Generate a specific world instead of a random one (only used when no save exists). |
| `SAVE_PATH` | Where the world is saved (default `./save.json`). |
