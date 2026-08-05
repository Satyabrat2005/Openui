# openui-browser — retired

The browser-first web product has moved to its own repository:
**https://github.com/Satyabrat2005/openui-web**

This folder was a copy that lived inside the desktop repo for review convenience
(introduced in PRs #153–#155). It has been retired to avoid two divergent copies:
`openui-web` is now the single canonical source, and it carries work this folder
never had — the vendored dependency tree (`src/vendor/`, so it has no dependency on
any sibling checkout) plus the container/deploy setup (`Dockerfile`, `render.yaml`).

Make all changes to the browser-first product in `openui-web`, not here.
