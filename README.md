# aaronredmond.github.io

Personal site, served by GitHub Pages at https://aaronredmond.github.io/.

It's plain HTML and CSS with no build step. Pushing to `main` publishes it.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The one-page site: intro, About, Tools, Scripts, Contact |
| `style.css` | Styling, with light and dark themes |
| `photo-to-pixel/` | PhotoToPixel, a built Vite/React app (source repo is private) |
| `text-extractor/` | Text Extractor, copied from the Text-Extractor repo |
| `wheel-game/` | WheelGame, copied from the WheelGame repo |
| `sync.sh` | Re-copies the three tools above from their local project folders |

The tool folders are copies, not the source of truth. Make changes in each tool's own project, then sync.

## Adding a browser tool

1. Put the tool in its own folder here, for example `my-tool/`, with an `index.html` that uses relative paths. If it's a built app, build it for the `/my-tool/` sub-path.
2. Add a card to the Tools section in `index.html`, copying an existing one. Include a "Source on GitHub" link only if the repo is public.
3. If it should be re-copied by `sync.sh`, add it to that script.

## Adding a script

Add a card to the Scripts section in `index.html`, linking to its GitHub repo.

## Syncing the tools

```sh
./sync.sh
git status    # review what changed
```

The script expects the project folders (`TextExtractor`, `Wheel`, `PhotoToPixel`) next to this one, or set `IDEAS_DIR` to point at their parent folder. PhotoToPixel is rebuilt with `npx vite build --base=/photo-to-pixel/`, so its dependencies must be installed. The script copies whatever is in those folders, committed or not.
