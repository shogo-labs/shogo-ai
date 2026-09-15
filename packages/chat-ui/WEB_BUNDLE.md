# Web bundle spike

The first web build uses React DOM and the shared presentation layer without
including the Studio shell:

* `dist/index.js`: 6.6 KB
* `dist/index.css`: 4.5 KB
* `dist/host.js`: 159 B (Studio host context, no CSS side effects)

The embed bundle is delivered in an iframe, so host-page CSS and React
instances do not affect the Studio-compatible chat surface.
